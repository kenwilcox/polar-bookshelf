import {SpectronRenderer} from '../../js/test/SpectronRenderer';
import {assert} from 'chai';

describe('Basic Test', function() {

    it("basic", async function () {
        assert.ok(1 == 1);
    });

});

SpectronRenderer.run(async (state) => {
    console.log("Running within SpectronRenderer now.");

    mocha.run((nrFailures: number) => {
        state.testResultWriter.write(true)
            .catch(err => console.error("Unable to write results: ", err));
    });

});

