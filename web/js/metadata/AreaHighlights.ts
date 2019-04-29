import {Hashcodes} from '../Hashcodes';
import {Preconditions} from '../Preconditions';
import {AreaHighlight} from './AreaHighlight';
import {ISODateTimeString, ISODateTimeStrings} from './ISODateTimeStrings';
import {DocMeta} from './DocMeta';
import {Image} from './Image';
import {Datastore} from '../datastore/Datastore';
import {BackendFileRef} from '../datastore/Datastore';
import {PersistenceLayer} from '../datastore/PersistenceLayer';
import {Images} from './Images';
import {DocMetas} from './DocMetas';
import {Backend} from '../datastore/Backend';
import {ArrayBuffers} from '../util/ArrayBuffers';
import {Attachment} from './Attachment';
import {Logger} from '../logger/Logger';
import {PageMeta} from './PageMeta';
import {AreaHighlightRect} from './AreaHighlightRect';
import {HighlightRects} from './BaseHighlight';
import {Position} from "./BaseHighlight";
import {DatastoreFileCache} from '../datastore/HybridRemoteDatastore';
import {ExtractedImage} from '../screenshots/CapturedScreenshot';
import {CapturedScreenshots} from '../screenshots/CapturedScreenshots';
import {Dimensions} from '../util/Dimensions';
import {DocFormatFactory} from '../docformat/DocFormatFactory';
import {ILTRect} from '../util/rects/ILTRect';

const log = Logger.create();

export class AreaHighlights {

    public static createID(created: ISODateTimeString) {
        // TODO: this needs some unique data and random is probably find.
        return Hashcodes.createID(created);
    }

    /**
     * Create a new pagemark with the created time, and other mandatory fields
     * added.
     *
     * @param opts
     * @return {AreaHighlight}
     */
    public static create(opts: IAreaHighlightOpts = {}) {

        Preconditions.assertNotNull(opts.rect, "rect");

        const created = ISODateTimeStrings.create();

        return new AreaHighlight({

            // per-pagemark fields.
            id: AreaHighlights.createID(created),

            created,

            // there is only one rect for an area highlight.
            rects: { "0": opts.rect }

        });

    }

    public static async doWrite(opts: DoWriteOpts): Promise<AreaHighlight> {

        const {datastore, pageNum, pageMeta, docMeta,
               areaHighlight, boxRect, target,
               areaHighlightRect} = opts;

        const {pageDimensions} = this.computePageDimensions(pageNum);

        // TODO: this is a problem because the area highlight isn't created
        // until we mutate it in the JSON..
        const extractedImage
            = await CapturedScreenshots.capture(pageNum, boxRect, target);

        const overlayRect = areaHighlightRect.toDimensions(pageDimensions);

        const position: Position = {
            x: overlayRect.left,
            y: overlayRect.top,
            width: overlayRect.width,
            height: overlayRect.height,
        };

        const writeOpts: AreaHighlightWriteOpts = {
            datastore,
            docMeta,
            pageMeta,
            areaHighlight,
            rect: areaHighlightRect,
            position,
            extractedImage
        };

        const writer = AreaHighlights.write(writeOpts);

        const [writtenAreaHighlight, committer] = writer.prepare();

        await committer.commit();

        return writtenAreaHighlight;
    }

    private static computePageDimensions(pageNum: number): PageDimensions {

        const docFormat = DocFormatFactory.getInstance();

        const pageElement = docFormat.getPageElementFromPageNum(pageNum);

        const dimensionsElement
            = <HTMLElement> pageElement.querySelector(".canvasWrapper, .iframeWrapper")!;

        const pageDimensions = new Dimensions({
            width: dimensionsElement.clientWidth,
            height: dimensionsElement.clientHeight
        });

        return {pageDimensions, dimensionsElement};

    }

    public static write(opts: AreaHighlightWriteOpts): AreaHighlightWriter {
        return new DefaultAreaHighlightWriter(opts);
    }

    public static async delete(opts: AreaHighlightDeleteOpts) {

        const {datastore, pageMeta, areaHighlight} = opts;
        const {image} = areaHighlight;

        delete pageMeta.areaHighlights[areaHighlight.id];

        if (image) {
            await datastore.deleteFile(image.src.backend, image.src);
        }

    }

}

interface PageDimensions {
    readonly pageDimensions: Dimensions;
    readonly dimensionsElement: HTMLElement;
}

export interface DoWriteOpts {
    readonly datastore: Datastore | PersistenceLayer;
    readonly docMeta: DocMeta;
    readonly pageMeta: PageMeta;
    readonly pageNum: number;
    readonly areaHighlight: AreaHighlight;
    readonly target: HTMLElement;
    readonly areaHighlightRect: AreaHighlightRect;
    readonly boxRect: ILTRect;
}

export interface AreaHighlightDeleteOpts {
    readonly datastore: Datastore | PersistenceLayer;
    readonly docMeta: DocMeta;
    readonly pageMeta: PageMeta;
    readonly areaHighlight: AreaHighlight;

}

export interface AreaHighlightWriteOpts {
    readonly datastore: Datastore | PersistenceLayer;
    readonly docMeta: DocMeta;
    readonly pageMeta: PageMeta;
    readonly areaHighlight: AreaHighlight;
    readonly rect: AreaHighlightRect;
    readonly position: Position;
    readonly extractedImage: ExtractedImage;
}

export interface AreaHighlightWriter {

    prepare(): [AreaHighlight, AreaHighlightCommitter];

}

class DefaultAreaHighlightWriter implements AreaHighlightWriter {

    constructor(private readonly opts: AreaHighlightWriteOpts) {
    }

    public prepare(): [AreaHighlight, AreaHighlightCommitter] {

        const {docMeta, extractedImage, pageMeta, areaHighlight, rect, position} = this.opts;

        const {type, width, height} = extractedImage;

        const id = Images.createID();
        const ext = Images.toExt(type);

        const fileRef: BackendFileRef = {
            // TODO: add the data hashcode
            backend: Backend.IMAGE,
            name: `${id}.${ext}`
        };

        // WARN: THE OPERATIONS HERE ARE ORDERED FOR SAFETY
        //
        // They MUST go in the following manner:
        //
        //  - write out the metadata to memory without writing to the datastore
        //
        //  - write the new file
        //
        //  - write the new DocMeta to the datastore
        //
        //  - delete the old file (this does not need to block)
        //
        //  This CAN live a dangling older file if the write is aborted or the
        //  client crashes but this is probably rare.  It could ALSO leave a NEW
        //  file in place but it won't leave inconsistent/broken data from a
        //  user perspective.
        //
        //  The only way around the danging binary file issue might be some sort
        //  of 'tag' operation where we write the files deletable before we
        //  delete them.

        const oldImage = areaHighlight.image;

        const image = new Image({
            id, type, width, height,
            rel: 'screenshot',
            src: fileRef,
        });

        const blob = ArrayBuffers.toBlob(extractedImage.data);

        const blobURL = URL.createObjectURL(blob);

        DatastoreFileCache.writeFile(Backend.IMAGE, image.src, {
            url: blobURL
        });

        // update the DocMeta but don't write yet.  We have to make sure the
        // write of the image made to the datastore first.

        const result = DocMetas.withSkippedMutations(docMeta, () => {

            if (areaHighlight.image) {
                delete docMeta.docInfo.attachments[areaHighlight.image.id];
            }

            docMeta.docInfo.attachments[image.id] = new Attachment({fileRef});

            const rects: HighlightRects = {};
            rects["0"] = <any> rect;

            const newAreaHighlight =  new AreaHighlight({
                ...areaHighlight,
                image,
                rects,
                position,
                lastUpdated: ISODateTimeStrings.create()
            });

            pageMeta.areaHighlights[newAreaHighlight.id] = newAreaHighlight!;

            return newAreaHighlight;

        });

        const committer = new DefaultAreaHighlightCommitter(this.opts, image, blob, oldImage);

        return [result, committer];

    }

}


export interface AreaHighlightCommitter {

    commit(): Promise<void>;

}

class DefaultAreaHighlightCommitter implements AreaHighlightCommitter {

    constructor(private readonly opts: AreaHighlightWriteOpts,
                private readonly image: Image,
                private readonly blob: Blob,
                private readonly oldImage: Image | undefined) {
    }

    public async commit(): Promise<void> {

        const {datastore, docMeta} = this.opts;
        const {image, oldImage, blob} = this;

        await datastore.writeFile(image.src.backend, image.src, blob);

        // now force a write of all the data and the current in memory version
        // will be written including the above skipped mutation.
        DocMetas.forceWrite(docMeta);

        if (oldImage) {
            datastore.deleteFile(oldImage.src.backend, oldImage.src)
                .catch(err => log.error("Unable to delete old image: ", err, oldImage));
        }

    }

}

interface IAreaHighlightOpts {
    readonly rect?: any;
}
