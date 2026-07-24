import assert from 'assert';
import {
    markIntegrationTestMarketCreates,
    withIntegrationTestSubType
} from '../src/integrationMarketUtils.js';

describe('integration market utilities', () => {
    it('marks an untyped top-level planning create without mutating its options', async () => {
        const options = {name: 'Integration workspace', market_type: 'PLANNING'};
        const createMarket = async (request) => request;
        const client = {markets: {createMarket}};
        markIntegrationTestMarketCreates(client);

        const request = await client.markets.createMarket(options);

        assert.deepStrictEqual(request, {
            name: 'Integration workspace',
            market_type: 'PLANNING',
            market_sub_type: 'INTEGRATION_TEST'
        });
        assert.deepStrictEqual(options, {name: 'Integration workspace', market_type: 'PLANNING'});
    });

    it('preserves explicit subtypes and leaves inline creates unmarked', () => {
        const explicitlyTyped = {
            name: 'Typed workspace',
            market_type: 'PLANNING',
            market_sub_type: 'TEST'
        };
        const inlinePlanningMarket = {
            market_type: 'PLANNING',
            parent_comment_id: 'comment-id'
        };

        assert.strictEqual(withIntegrationTestSubType(explicitlyTyped), explicitlyTyped);
        assert.strictEqual(
            withIntegrationTestSubType(inlinePlanningMarket),
            inlinePlanningMarket
        );
    });
});
