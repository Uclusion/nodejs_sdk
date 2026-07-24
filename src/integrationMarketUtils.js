const PLANNING_MARKET_TYPE = 'PLANNING';
const INTEGRATION_TEST_SUB_TYPE = 'INTEGRATION_TEST';

function isTopLevelMarket(market) {
    return !market.parent_comment_id && !market.parent_comment_market_id;
}

export function withIntegrationTestSubType(marketOptions) {
    if (marketOptions.market_type !== PLANNING_MARKET_TYPE ||
        !isTopLevelMarket(marketOptions) ||
        marketOptions.market_sub_type) {
        return marketOptions;
    }
    return {
        ...marketOptions,
        market_sub_type: INTEGRATION_TEST_SUB_TYPE
    };
}

export function markIntegrationTestMarketCreates(client) {
    const createMarket = client.markets.createMarket.bind(client.markets);
    client.markets.createMarket = (marketOptions) => {
        // Account clients in this package are integration-test harness clients.
        // Centralizing the marker prevents a new suite from creating a root
        // that the guarded cleanup cascade must refuse.
        return createMarket(withIntegrationTestSubType(marketOptions));
    };
    return client;
}
