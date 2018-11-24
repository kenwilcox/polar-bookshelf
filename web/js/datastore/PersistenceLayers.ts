import {PersistenceLayer} from "./PersistenceLayer";
import {NULL_FUNCTION} from "../util/Functions";
import {Percentages} from '../util/Percentages';
import {Backend} from './Backend';
import {Blobs} from "../util/Blobs";
import {ArrayBuffers} from "../util/ArrayBuffers";
import {AsyncFunction, AsyncWorkQueue} from '../util/AsyncWorkQueue';
import {DocMetaRef} from "./DocMetaRef";
import {Datastore, DocMetaMutation, DocMetaSnapshotEvent, FileRef} from './Datastore';
import {UUIDs} from '../metadata/UUIDs';
import {ProgressTracker} from '../util/ProgressTracker';
import {DocMetas} from '../metadata/DocMetas';
import {DefaultPersistenceLayer} from './DefaultPersistenceLayer';

export class PersistenceLayers {

    public static toPersistenceLayer(input: Datastore ): PersistenceLayer {
        return new DefaultPersistenceLayer(input);
    }

    /**
     * Synchronize the source with the target so that we know they are both in
     * sync.
     */
    public static async synchronize(source: PersistenceLayer,
                                    target: PersistenceLayer,
                                    listener: SynchronizeEventListener = NULL_FUNCTION): Promise<TransferResult> {

        const result: TransferResult = {
            mutations: {
                fingerprints: [],
                files: []
            },
            conflicts: {
                fingerprints: [],
                files: []
            }
        };

        async function handleStashFile(fileRef: FileRef) {

            if (! target.containsFile(Backend.STASH, fileRef)) {

                const optionalFile = await source.getFile(Backend.STASH, fileRef);

                if (optionalFile.isPresent()) {
                    const file = optionalFile.get();
                    const response = await fetch(file.url);
                    const blob = await response.blob();
                    const arrayBuffer = await Blobs.toArrayBuffer(blob);
                    const buffer = ArrayBuffers.toBuffer(arrayBuffer);

                    target.writeFile(file.backend, fileRef, buffer, file.meta);

                    result.mutations.files.push(fileRef);
                }

            }

        }

        async function handleDocMetaFile(docMetaFile: DocMetaRef) {

            // console.log("Working with fingerprint: " + docMetaFile.fingerprint);

            const docMeta = await source.getDocMeta(docMetaFile.fingerprint);

            if (! docMeta) {
                return;
            }

            const docFile: FileRef = {
                name: docMeta.docInfo.filename!,
                hashcode: docMeta.docInfo.hashcode
            };

            // TODO: we're going to need some type of method to get all the
            // files backing a DocMeta file when we start to use attachments
            // like screenshots.

            if (docFile.name) {
                // TODO: if we use the second queue it still locks up.
                // await docFileAsyncWorkQueue.enqueue(async () => handleStashFile(docFile));
                await handleStashFile(docFile);
            }

            const targetContainsDocMeta: boolean = await target.contains(docMetaFile.fingerprint);

            let doWriteDocMeta: boolean = ! targetContainsDocMeta;

            if (targetContainsDocMeta) {

                const targetDocMeta = await target.getDocMeta(docMetaFile.fingerprint);

                if (targetDocMeta) {

                    const cmp = UUIDs.compare(targetDocMeta.docInfo.uuid, docMeta.docInfo.uuid);

                    // FIXME: if the comparison is zero then technically we have a
                    // conflict which we need to surface to the user.

                    doWriteDocMeta = cmp < 0;

                }

            }

            if (doWriteDocMeta) {
                result.mutations.fingerprints.push(docMetaFile.fingerprint);
                await target.writeDocMeta(docMeta);
            }

            ++completed;

            const progress = Percentages.calculate(completed, total);

            const duration = Date.now() - before;

            listener({completed, total, progress, duration});

        }

        const docMetaFiles = await source.getDocMetaFiles();

        const before = Date.now();
        const total = docMetaFiles.length;
        let completed = 0;

        const docFileAsyncWorkQueue = new AsyncWorkQueue([]);
        const docMetaAsyncWorkQueue = new AsyncWorkQueue([]);

        // build a work queue of async functions out of the docMetaFiles.
        docMetaFiles.forEach(docMetaFile =>
                                 docMetaAsyncWorkQueue.enqueue( async () => handleDocMetaFile(docMetaFile)));

        const docFileExecutionPromise = docFileAsyncWorkQueue.execute();
        const docMetaExecutionPromise = docMetaAsyncWorkQueue.execute();

        await Promise.all([docFileExecutionPromise, docMetaExecutionPromise]);

        return result;

    }

}

export interface TransferResult {

    readonly mutations: TransferRefs;

    readonly conflicts: TransferRefs;

}

export interface TransferRefs {

    readonly fingerprints: string[];

    readonly files: FileRef[];

}

export interface SynchronizeEvent {

    readonly completed: number;

    /**
     * The total number of tasks.
     */
    readonly total: number;

    /**
     * The progress as a percentage (0 to 100)
     */
    readonly progress: number;

    readonly duration: number;

}

export type SynchronizeEventListener = (synchronizeEvent: SynchronizeEvent) => void;