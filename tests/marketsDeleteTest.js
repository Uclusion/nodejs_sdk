import assert from 'assert';
import { randomUUID } from 'crypto';
import AWS from 'aws-sdk';
import {
    loginUserToAccount,
    loginUserToMarket
} from '../src/utils.js';
import { pollFor } from './commonTestFunctions.js';

const REGION = 'us-west-2';
const DEV_BASE_URL = 'https://dev.api.uclusion.com/v1';
const DELETE_FUNCTION = 'uclusion-markets-dev-markets_delete';
const INVESTIBLES_CREATE_FUNCTION =
    'uclusion-markets-dev-investibles_create';
const INTEGRATION_TEST_SUB_TYPE = 'INTEGRATION_TEST';
const NORMAL_OBJECT_TYPE = 'NORMAL';

const TABLES = {
    comments: 'uclusion-markets-dev-comments',
    groups: 'uclusion-markets-dev-groups',
    investibleInfos: 'uclusion-markets-dev-investibles-infos',
    investibles: 'uclusion-markets-dev-investibles',
    markets: 'uclusion-markets-dev-markets',
    stages: 'uclusion-markets-dev-stages',
    capabilities: 'uclusion-users-dev-users-capabilities',
    versions: 'uclusion-summaries-dev-object-versions'
};

const POLL_ATTEMPTS = 40;
const POLL_INTERVAL_MS = 3000;
const QUIESCENCE_POLLS = 3;
const LAMBDA_HTTP_TIMEOUT_MS = 210000;

function assertDevConfiguration(configuration) {
    assert.strictEqual(
        configuration.baseURL,
        DEV_BASE_URL,
        'The hard-delete integration scenario may run against DEV only'
    );
}

function machineCapability(marketId) {
    return {
        role: 'Machine',
        is_admin: true,
        type: 'market',
        id: marketId
    };
}

function createLambdaClient() {
    return new AWS.Lambda({
        region: REGION,
        maxRetries: 0,
        httpOptions: {
            // markets_delete may legitimately run for its full 180s timeout.
            timeout: LAMBDA_HTTP_TIMEOUT_MS
        }
    });
}

function defaultGroupVersionKey(marketId) {
    // The default group shares the market ID, but group_updated passes that ID
    // as both the primary and secondary object IDs to save_version.
    return `${marketId}_${marketId}`;
}

function requireQuiescence(predicate) {
    let consecutiveMatches = 0;
    return (value) => {
        if (predicate(value)) {
            consecutiveMatches += 1;
        } else {
            consecutiveMatches = 0;
        }
        return consecutiveMatches >= QUIESCENCE_POLLS;
    };
}

function hasActiveCapability(items, userId) {
    return items.some((item) => (
        item.user_id === userId
        && item.deleted !== true
        && item.market_banned !== true
    ));
}

function decodeLambdaPayload(response, functionName) {
    assert.strictEqual(
        response.StatusCode,
        200,
        `${functionName} invocation failed with status ${response.StatusCode}`
    );
    const payloadText = Buffer.from(response.Payload || '').toString('utf8');
    let envelope;
    try {
        envelope = JSON.parse(payloadText);
    } catch (error) {
        assert.fail(
            `${functionName} returned invalid JSON: ${payloadText}`
        );
    }
    if (response.FunctionError || envelope.errorMessage) {
        assert.fail(
            `${functionName} failed: ${response.FunctionError || envelope.errorMessage}`
        );
    }
    let body = envelope.body;
    if (typeof body === 'string') {
        try {
            body = JSON.parse(body);
        } catch (error) {
            // Preserve a non-JSON error body for a useful assertion message.
        }
    }
    return {
        statusCode: envelope.statusCode,
        body
    };
}

async function invokeJsonLambda(
    lambda,
    functionName,
    payload,
    capability
) {
    const parameters = {
        FunctionName: functionName,
        InvocationType: 'RequestResponse',
        Payload: JSON.stringify(payload)
    };
    if (capability) {
        parameters.ClientContext = Buffer.from(JSON.stringify({
            custom: { capability }
        })).toString('base64');
    }
    const response = await lambda.invoke(parameters).promise();
    return decodeLambdaPayload(response, functionName);
}

function invokeDelete(lambda, marketId) {
    return invokeJsonLambda(
        lambda,
        DELETE_FUNCTION,
        { capability: machineCapability(marketId) }
    );
}

async function getItem(documentClient, tableName, id) {
    const response = await documentClient.get({
        TableName: tableName,
        Key: { id },
        ConsistentRead: true
    }).promise();
    return response.Item;
}

async function readItems(documentClient, tableName, ids) {
    const items = await Promise.all(
        ids.map((id) => getItem(documentClient, tableName, id))
    );
    return new Map(
        items
            .filter(Boolean)
            .map((item) => [item.id, item])
    );
}

async function readExpectedRecordState(documentClient, expectedRecords) {
    const state = {};
    await Promise.all(
        Object.entries(expectedRecords).map(async ([tableName, ids]) => {
            state[tableName] = await readItems(
                documentClient,
                tableName,
                ids
            );
        })
    );
    return state;
}

function expectedRecordsArePresent(state, expectedRecords) {
    return Object.entries(expectedRecords).every(([tableName, ids]) => (
        state[tableName].size === ids.length
        && ids.every((id) => state[tableName].has(id))
    ));
}

async function waitForExpectedRecordsToExist(
    documentClient,
    expectedRecords
) {
    const lastState = await pollFor(
        () => readExpectedRecordState(documentClient, expectedRecords),
        requireQuiescence(
            (state) => expectedRecordsArePresent(state, expectedRecords)
        ),
        POLL_ATTEMPTS,
        POLL_INTERVAL_MS
    );
    const missing = Object.entries(expectedRecords)
        .flatMap(([tableName, ids]) => ids
            .filter((id) => !lastState[tableName].has(id))
            .map((id) => `${tableName}:${id}`));
    assert.deepStrictEqual(
        missing,
        [],
        `Fixture records did not converge: ${missing.join(', ')}`
    );
}

async function waitForExpectedRecordsToDisappear(
    documentClient,
    expectedRecords
) {
    const lastState = await pollFor(
        () => readExpectedRecordState(documentClient, expectedRecords),
        requireQuiescence(
            (state) => Object.values(state).every(
                (items) => items.size === 0
            )
        ),
        POLL_ATTEMPTS,
        POLL_INTERVAL_MS
    );
    const leftovers = Object.entries(lastState)
        .flatMap(([tableName, items]) => (
            [...items.keys()].map((id) => `${tableName}:${id}`)
        ));
    assert.deepStrictEqual(
        leftovers,
        [],
        `Hard delete left DynamoDB records: ${leftovers.join(', ')}`
    );
}

async function queryCapabilities(documentClient, typeObjectId) {
    const response = await documentClient.query({
        TableName: TABLES.capabilities,
        IndexName: 'type_object_index',
        KeyConditionExpression: '#typeObjectId = :typeObjectId',
        ExpressionAttributeNames: {
            '#typeObjectId': 'type_object_id'
        },
        ExpressionAttributeValues: {
            ':typeObjectId': typeObjectId
        }
    }).promise();
    return response.Items || [];
}

async function readCapabilityState(documentClient, typeObjectIds) {
    const entries = await Promise.all(
        typeObjectIds.map(async (typeObjectId) => [
            typeObjectId,
            await queryCapabilities(documentClient, typeObjectId)
        ])
    );
    return Object.fromEntries(entries);
}

async function waitForCapabilities(
    documentClient,
    typeObjectIds,
    predicate,
    errorMessage
) {
    const lastState = await pollFor(
        () => readCapabilityState(documentClient, typeObjectIds),
        requireQuiescence(
            (state) => typeObjectIds.every(
                (typeObjectId) => predicate(state[typeObjectId])
            )
        ),
        POLL_ATTEMPTS,
        POLL_INTERVAL_MS
    );
    const failedKeys = typeObjectIds.filter(
        (typeObjectId) => !predicate(lastState[typeObjectId])
    );
    assert.deepStrictEqual(
        failedKeys,
        [],
        `${errorMessage}: ${failedKeys.join(', ')}`
    );
    return lastState;
}

async function queryVersions(documentClient, marketId) {
    const response = await documentClient.query({
        TableName: TABLES.versions,
        KeyConditionExpression: '#groupId = :groupId',
        ExpressionAttributeNames: {
            '#groupId': 'group_id'
        },
        ExpressionAttributeValues: {
            ':groupId': marketId
        },
        ConsistentRead: true
    }).promise();
    return response.Items || [];
}

async function waitForVersionKeys(documentClient, marketId, expectedKeys) {
    const lastRows = await pollFor(
        () => queryVersions(documentClient, marketId),
        requireQuiescence((rows) => {
            const foundKeys = new Set(
                rows.map((row) => row.object_id_one_two)
            );
            return expectedKeys.every((key) => foundKeys.has(key));
        }),
        POLL_ATTEMPTS,
        POLL_INTERVAL_MS
    );
    const foundKeys = new Set(
        lastRows.map((row) => row.object_id_one_two)
    );
    const missingKeys = expectedKeys.filter((key) => !foundKeys.has(key));
    assert.deepStrictEqual(
        missingKeys,
        [],
        `Object versions did not converge for ${marketId}`
    );
}

async function waitForVersionPartitionToDisappear(
    documentClient,
    marketId
) {
    const lastRows = await pollFor(
        () => queryVersions(documentClient, marketId),
        requireQuiescence((rows) => rows.length === 0),
        POLL_ATTEMPTS,
        POLL_INTERVAL_MS
    );
    assert.deepStrictEqual(
        lastRows,
        [],
        `Object-version partition remains for ${marketId}`
    );
}

async function waitForCleanupState(documentClient, cleanupState) {
    if (!cleanupState) {
        return;
    }
    await Promise.all([
        waitForExpectedRecordsToDisappear(
            documentClient,
            cleanupState.records
        ),
        waitForCapabilities(
            documentClient,
            cleanupState.capabilityIds,
            (items) => items.length === 0,
            'Cleanup left capabilities'
        ),
        ...cleanupState.versionMarketIds.map(
            (marketId) => waitForVersionPartitionToDisappear(
                documentClient,
                marketId
            )
        )
    ]);
}

function fixtureFromResponse(response, name) {
    return {
        id: response.market.id,
        name,
        accountId: response.market.account_id,
        createdBy: response.market.created_by,
        stages: response.stages
    };
}

async function createRoot(accountClient, name) {
    const response = await accountClient.markets.createMarket({
        market_type: 'PLANNING',
        name
    });
    return {
        response,
        fixture: fixtureFromResponse(response, name)
    };
}

function assertIntegrationTestRoot(response) {
    assert.strictEqual(
        response.market.market_sub_type,
        INTEGRATION_TEST_SUB_TYPE,
        'Integration root was not marked for guarded deletion'
    );
}

async function makeFixtureDeletable(documentClient, fixture) {
    const market = await getItem(
        documentClient,
        TABLES.markets,
        fixture.id
    );
    if (!market) {
        return false;
    }
    assert.strictEqual(
        market.name,
        fixture.name,
        `Refusing to clean up unexpected market ${fixture.id}`
    );
    assert.strictEqual(
        market.account_id,
        fixture.accountId,
        `Refusing to clean up market ${fixture.id} from another account`
    );
    assert.strictEqual(
        market.created_by,
        fixture.createdBy,
        `Refusing to clean up market ${fixture.id} from another creator`
    );
    assert.strictEqual(
        market.object_type,
        NORMAL_OBJECT_TYPE,
        `Refusing to reclassify unexpected object type for ${fixture.id}`
    );
    if (market.market_sub_type === INTEGRATION_TEST_SUB_TYPE) {
        return true;
    }
    assert.strictEqual(
        market.market_sub_type,
        undefined,
        `Refusing to reclassify unexpected subtype for ${fixture.id}`
    );
    await documentClient.update({
        TableName: TABLES.markets,
        Key: { id: fixture.id },
        UpdateExpression: 'SET #subType = :integrationTest',
        ConditionExpression: [
            '#name = :name',
            '#accountId = :accountId',
            '#createdBy = :createdBy',
            '#objectType = :normal',
            'attribute_not_exists(#subType)'
        ].join(' AND '),
        ExpressionAttributeNames: {
            '#name': 'name',
            '#accountId': 'account_id',
            '#createdBy': 'created_by',
            '#objectType': 'object_type',
            '#subType': 'market_sub_type'
        },
        ExpressionAttributeValues: {
            ':name': fixture.name,
            ':accountId': fixture.accountId,
            ':createdBy': fixture.createdBy,
            ':normal': NORMAL_OBJECT_TYPE,
            ':integrationTest': INTEGRATION_TEST_SUB_TYPE
        }
    }).promise();
    return true;
}

async function deleteFixtureIfPresent(
    documentClient,
    lambda,
    fixture
) {
    if (!fixture || !await makeFixtureDeletable(documentClient, fixture)) {
        return;
    }
    const response = await invokeDelete(lambda, fixture.id);
    assert.strictEqual(
        response.statusCode,
        200,
        `Cleanup delete failed for ${fixture.id}: ${JSON.stringify(response.body)}`
    );
    const remaining = await pollFor(
        () => getItem(documentClient, TABLES.markets, fixture.id),
        requireQuiescence((market) => !market),
        POLL_ATTEMPTS,
        POLL_INTERVAL_MS
    );
    assert.strictEqual(
        remaining,
        undefined,
        `Cleanup did not delete ${fixture.id}`
    );
}

function normalizedMarketInfos(investible) {
    return (investible.market_infos || [])
        .map((marketInfo) => ({
            id: marketInfo.id,
            market_id: marketInfo.market_id
        }))
        .sort((left, right) => left.id.localeCompare(right.id));
}

async function deleteSharedInvestibleOrphan(documentClient, guard) {
    if (!guard) {
        return;
    }
    const roots = await Promise.all(
        guard.rootMarketIds.map((marketId) => getItem(
            documentClient,
            TABLES.markets,
            marketId
        ))
    );
    assert(
        roots.every((market) => !market),
        'Refusing raw shared-investible cleanup while a fixture root exists'
    );

    const investible = await getItem(
        documentClient,
        TABLES.investibles,
        guard.id
    );
    if (!investible) {
        return;
    }
    assert.strictEqual(investible.id, guard.id);
    assert.strictEqual(investible.name, guard.name);
    assert.strictEqual(investible.created_by, guard.createdBy);
    assert(Number.isInteger(investible.version));

    const allowedMarketIds = new Set(guard.rootMarketIds);
    const marketInfos = normalizedMarketInfos(investible);
    assert(
        marketInfos.every((marketInfo) => (
            marketInfo.id
            && allowedMarketIds.has(marketInfo.market_id)
        )),
        'Refusing raw cleanup of an investible shared outside its fixtures'
    );
    const infoRecords = (await Promise.all(
        marketInfos.map((marketInfo) => getItem(
            documentClient,
            TABLES.investibleInfos,
            marketInfo.id
        ))
    )).filter(Boolean);
    for (const infoRecord of infoRecords) {
        assert.strictEqual(infoRecord.investible_id, guard.id);
        assert(allowedMarketIds.has(infoRecord.market_id));
        assert.strictEqual(infoRecord.created_by, guard.createdBy);
    }

    const expressionAttributeNames = {
        '#createdBy': 'created_by',
        '#marketInfos': 'market_infos',
        '#name': 'name',
        '#version': 'version'
    };
    const expressionAttributeValues = {
        ':createdBy': guard.createdBy,
        ':marketInfos': investible.market_infos || [],
        ':name': guard.name,
        ':version': investible.version
    };
    const conditions = [
        '#createdBy = :createdBy',
        '#marketInfos = :marketInfos',
        '#name = :name',
        '#version = :version'
    ];
    await documentClient.delete({
        TableName: TABLES.investibles,
        Key: { id: guard.id },
        ConditionExpression: conditions.join(' AND '),
        ExpressionAttributeNames: expressionAttributeNames,
        ExpressionAttributeValues: expressionAttributeValues
    }).promise();

    await Promise.all(infoRecords.map((infoRecord) => documentClient.delete({
        TableName: TABLES.investibleInfos,
        Key: { id: infoRecord.id },
        ConditionExpression: [
            '#createdBy = :createdBy',
            '#investibleId = :investibleId',
            '(#marketId = :rootOne OR #marketId = :rootTwo)'
        ].join(' AND '),
        ExpressionAttributeNames: {
            '#createdBy': 'created_by',
            '#investibleId': 'investible_id',
            '#marketId': 'market_id'
        },
        ExpressionAttributeValues: {
            ':createdBy': guard.createdBy,
            ':investibleId': guard.id,
            ':rootOne': guard.rootMarketIds[0],
            ':rootTwo': guard.rootMarketIds[1]
        }
    }).promise()));

    const orphanRecords = {
        [TABLES.investibles]: [guard.id],
        [TABLES.investibleInfos]: marketInfos.map(
            (marketInfo) => marketInfo.id
        )
    };
    await waitForExpectedRecordsToDisappear(
        documentClient,
        orphanRecords
    );
    await waitForCapabilities(
        documentClient,
        marketInfos.map((marketInfo) => `investible_${marketInfo.id}`),
        (items) => items.length === 0,
        'Raw orphan cleanup left investible capabilities'
    );
}

async function waitForSharedSurvivor(
    documentClient,
    investibleId,
    investibleInfoId,
    marketId
) {
    const expectedMarketInfos = [{
        id: investibleInfoId,
        market_id: marketId
    }];
    const lastState = await pollFor(
        async () => ({
            investible: await getItem(
                documentClient,
                TABLES.investibles,
                investibleId
            ),
            investibleInfo: await getItem(
                documentClient,
                TABLES.investibleInfos,
                investibleInfoId
            )
        }),
        requireQuiescence((state) => (
            state.investible
            && state.investibleInfo
            && JSON.stringify(normalizedMarketInfos(state.investible))
                === JSON.stringify(expectedMarketInfos)
            && state.investibleInfo.investible_id === investibleId
            && state.investibleInfo.market_id === marketId
        )),
        POLL_ATTEMPTS,
        POLL_INTERVAL_MS
    );
    assert(lastState.investible, 'Shared survivor investible is missing');
    assert(lastState.investibleInfo, 'Shared survivor info is missing');
    assert.deepStrictEqual(
        normalizedMarketInfos(lastState.investible),
        expectedMarketInfos,
        'Shared investible retained a deleted association'
    );
    assert.strictEqual(
        lastState.investibleInfo.investible_id,
        investibleId
    );
    assert.strictEqual(lastState.investibleInfo.market_id, marketId);
}

export default function marketsDeleteTest(adminConfiguration) {
    describe('#delete DEV integration-test markets', () => {
        it('deletes an inline cascade while preserving a shared survivor', async () => {
            assertDevConfiguration(adminConfiguration);
            const documentClient = new AWS.DynamoDB.DocumentClient({
                region: REGION
            });
            const lambda = createLambdaClient();
            const runId = randomUUID();
            const targetName = `Delete cascade ${runId}`;
            const survivorName = `Delete survivor ${runId}`;
            const sharedName = `Shared ${runId}`;
            let targetFixture;
            let survivorFixture;
            let targetCleanupState;
            let survivorCleanupState;
            let sharedOrphanGuard;

            try {
                const accountClient = await loginUserToAccount(
                    adminConfiguration
                );
                const adminUser = await accountClient.users.get();
                const targetRoot = await createRoot(
                    accountClient,
                    targetName
                );
                targetFixture = targetRoot.fixture;
                assertIntegrationTestRoot(targetRoot.response);
                const survivorRoot = await createRoot(
                    accountClient,
                    survivorName
                );
                survivorFixture = survivorRoot.fixture;
                assertIntegrationTestRoot(survivorRoot.response);

                const targetClient = await loginUserToMarket(
                    adminConfiguration,
                    targetFixture.id
                );
                const survivorClient = await loginUserToMarket(
                    adminConfiguration,
                    survivorFixture.id
                );

                const unshared = await targetClient.investibles.create({
                    groupId: targetFixture.id,
                    name: `Unshared ${runId}`,
                    addressed: [adminUser.id]
                });
                const unsharedInvestibleId = unshared.investible.id;
                const unsharedInfoId = unshared.market_infos[0].id;

                const shared = await targetClient.investibles.create({
                    groupId: targetFixture.id,
                    name: sharedName,
                    addressed: [adminUser.id]
                });
                const sharedInvestibleId = shared.investible.id;
                const targetSharedInfoId = shared.market_infos[0].id;
                sharedOrphanGuard = {
                    id: sharedInvestibleId,
                    name: sharedName,
                    createdBy: adminUser.id,
                    rootMarketIds: [
                        targetFixture.id,
                        survivorFixture.id
                    ]
                };

                const holderComment =
                    await targetClient.investibles.createComment(
                        unsharedInvestibleId,
                        targetFixture.id,
                        `Inline holder ${runId}`,
                        null,
                        'QUESTION'
                    );
                const inlineResponse =
                    await accountClient.markets.createMarket({
                        market_type: 'DECISION',
                        parent_comment_id: holderComment.id
                    });
                const inlineMarketId = inlineResponse.market.id;
                const inlineClient = await loginUserToMarket(
                    adminConfiguration,
                    inlineMarketId
                );
                const inlineInvestible =
                    await inlineClient.investibles.create({
                        groupId: inlineMarketId,
                        name: `Inline option ${runId}`,
                        addressed: [adminUser.id]
                    });
                const inlineInvestibleId =
                    inlineInvestible.investible.id;
                const inlineInfoId = inlineInvestible.market_infos[0].id;
                const inlineComment =
                    await inlineClient.investibles.createComment(
                        inlineInvestibleId,
                        inlineMarketId,
                        `Inline data ${runId}`,
                        null,
                        'QUESTION'
                    );

                const sharedAttach = await invokeJsonLambda(
                    lambda,
                    INVESTIBLES_CREATE_FUNCTION,
                    {
                        acting_user_id: adminUser.id,
                        investible_id: sharedInvestibleId,
                        group_id: survivorFixture.id
                    },
                    machineCapability(survivorFixture.id)
                );
                assert.strictEqual(
                    sharedAttach.statusCode,
                    200,
                    `Could not share fixture investible: ${JSON.stringify(sharedAttach.body)}`
                );
                const survivorSharedInfoId =
                    sharedAttach.body.market_infos[0].id;
                await survivorClient.investibles.follow(
                    sharedInvestibleId,
                    [{
                        user_id: adminUser.id,
                        is_following: true
                    }]
                );

                const holderRecord = await getItem(
                    documentClient,
                    TABLES.comments,
                    holderComment.id
                );
                assert.strictEqual(
                    holderRecord.inline_market_id,
                    inlineMarketId,
                    'Inline fixture does not have a reciprocal holder link'
                );
                assert.strictEqual(
                    inlineResponse.market.parent_comment_market_id,
                    targetFixture.id,
                    'Inline fixture points at the wrong parent market'
                );

                const deletedRecords = {
                    [TABLES.markets]: [
                        targetFixture.id,
                        inlineMarketId
                    ],
                    [TABLES.groups]: [
                        targetFixture.id,
                        inlineMarketId
                    ],
                    [TABLES.stages]: [
                        ...targetFixture.stages.map((stage) => stage.id),
                        ...inlineResponse.stages.map((stage) => stage.id)
                    ],
                    [TABLES.comments]: [
                        holderComment.id,
                        inlineComment.id
                    ],
                    [TABLES.investibleInfos]: [
                        unsharedInfoId,
                        targetSharedInfoId,
                        inlineInfoId
                    ],
                    [TABLES.investibles]: [
                        unsharedInvestibleId,
                        inlineInvestibleId
                    ]
                };
                const survivorRecords = {
                    [TABLES.markets]: [survivorFixture.id],
                    [TABLES.groups]: [survivorFixture.id],
                    [TABLES.stages]:
                        survivorFixture.stages.map((stage) => stage.id),
                    [TABLES.investibleInfos]: [survivorSharedInfoId],
                    [TABLES.investibles]: [sharedInvestibleId]
                };
                await waitForExpectedRecordsToExist(
                    documentClient,
                    deletedRecords
                );
                await waitForExpectedRecordsToExist(
                    documentClient,
                    survivorRecords
                );

                const deletedCapabilityIds = [
                    `market_${targetFixture.id}`,
                    `group_${targetFixture.id}`,
                    `market_${inlineMarketId}`,
                    `group_${inlineMarketId}`,
                    `investible_${unsharedInfoId}`,
                    `investible_${targetSharedInfoId}`,
                    `investible_${inlineInfoId}`
                ];
                const survivorCapabilityIds = [
                    `market_${survivorFixture.id}`,
                    `group_${survivorFixture.id}`,
                    `investible_${survivorSharedInfoId}`
                ];
                targetCleanupState = {
                    records: deletedRecords,
                    capabilityIds: deletedCapabilityIds,
                    versionMarketIds: [
                        targetFixture.id,
                        inlineMarketId
                    ]
                };
                survivorCleanupState = {
                    records: survivorRecords,
                    capabilityIds: survivorCapabilityIds,
                    versionMarketIds: [survivorFixture.id]
                };
                await Promise.all([
                    waitForCapabilities(
                        documentClient,
                        deletedCapabilityIds,
                        (items) => hasActiveCapability(
                            items,
                            adminUser.id
                        ),
                        'Fixture capabilities were not created'
                    ),
                    waitForCapabilities(
                        documentClient,
                        survivorCapabilityIds,
                        (items) => hasActiveCapability(
                            items,
                            adminUser.id
                        ),
                        'Survivor capabilities were not created'
                    ),
                    waitForVersionKeys(
                        documentClient,
                        targetFixture.id,
                        [
                            targetFixture.id,
                            defaultGroupVersionKey(targetFixture.id),
                            ...targetFixture.stages.map(
                                (stage) => stage.id
                            ),
                            holderComment.id,
                            `${unsharedInfoId}_${unsharedInvestibleId}`,
                            `${targetSharedInfoId}_${sharedInvestibleId}`
                        ]
                    ),
                    waitForVersionKeys(
                        documentClient,
                        inlineMarketId,
                        [
                            inlineMarketId,
                            defaultGroupVersionKey(inlineMarketId),
                            ...inlineResponse.stages.map(
                                (stage) => stage.id
                            ),
                            inlineComment.id,
                            `${inlineInfoId}_${inlineInvestibleId}`
                        ]
                    ),
                    waitForVersionKeys(
                        documentClient,
                        survivorFixture.id,
                        [
                            survivorFixture.id,
                            defaultGroupVersionKey(survivorFixture.id),
                            ...survivorFixture.stages.map(
                                (stage) => stage.id
                            ),
                            `${survivorSharedInfoId}_${sharedInvestibleId}`
                        ]
                    )
                ]);

                const deletion = await invokeDelete(
                    lambda,
                    targetFixture.id
                );
                assert.deepStrictEqual(deletion, {
                    statusCode: 200,
                    body: { success_message: 'Market deleted' }
                });

                await Promise.all([
                    waitForExpectedRecordsToDisappear(
                        documentClient,
                        deletedRecords
                    ),
                    waitForCapabilities(
                        documentClient,
                        deletedCapabilityIds,
                        (items) => items.length === 0,
                        'Deleted capabilities remain'
                    ),
                    waitForVersionPartitionToDisappear(
                        documentClient,
                        targetFixture.id
                    ),
                    waitForVersionPartitionToDisappear(
                        documentClient,
                        inlineMarketId
                    )
                ]);

                await waitForExpectedRecordsToExist(
                    documentClient,
                    survivorRecords
                );
                await waitForCapabilities(
                    documentClient,
                    survivorCapabilityIds,
                    (items) => hasActiveCapability(items, adminUser.id),
                    'Survivor capabilities were removed'
                );
                await waitForVersionKeys(
                    documentClient,
                    survivorFixture.id,
                    [
                        survivorFixture.id,
                        `${survivorSharedInfoId}_${sharedInvestibleId}`
                    ]
                );
                await waitForSharedSurvivor(
                    documentClient,
                    sharedInvestibleId,
                    survivorSharedInfoId,
                    survivorFixture.id
                );

                const retry = await invokeDelete(
                    lambda,
                    targetFixture.id
                );
                assert.deepStrictEqual(retry, {
                    statusCode: 200,
                    body: {
                        success_message: 'Market already deleted'
                    }
                });
            } finally {
                const cleanupErrors = [];
                for (const [fixture, cleanupState] of [
                    [targetFixture, targetCleanupState],
                    [survivorFixture, survivorCleanupState]
                ]) {
                    try {
                        await deleteFixtureIfPresent(
                            documentClient,
                            lambda,
                            fixture
                        );
                        await waitForCleanupState(
                            documentClient,
                            cleanupState
                        );
                    } catch (error) {
                        cleanupErrors.push(error);
                    }
                }
                try {
                    await deleteSharedInvestibleOrphan(
                        documentClient,
                        sharedOrphanGuard
                    );
                } catch (error) {
                    cleanupErrors.push(error);
                }
                if (cleanupErrors.length === 1) {
                    throw cleanupErrors[0];
                }
                if (cleanupErrors.length > 1) {
                    throw new AggregateError(
                        cleanupErrors,
                        'Deletion fixture cleanup failed'
                    );
                }
            }
        }).timeout(1800000);

        it('rejects a NORMAL market and conditionally restores cleanup eligibility', async () => {
            assertDevConfiguration(adminConfiguration);
            const documentClient = new AWS.DynamoDB.DocumentClient({
                region: REGION
            });
            const lambda = createLambdaClient();
            const runId = randomUUID();
            const fixtureName = `Delete rejection ${runId}`;
            let fixture;
            let cleanupState;

            try {
                const accountClient = await loginUserToAccount(
                    adminConfiguration
                );
                const adminUser = await accountClient.users.get();
                const root = await createRoot(
                    accountClient,
                    fixtureName
                );
                fixture = root.fixture;
                assertIntegrationTestRoot(root.response);
                cleanupState = {
                    records: {
                        [TABLES.markets]: [fixture.id],
                        [TABLES.groups]: [fixture.id],
                        [TABLES.stages]:
                            fixture.stages.map((stage) => stage.id)
                    },
                    capabilityIds: [
                        `market_${fixture.id}`,
                        `group_${fixture.id}`
                    ],
                    versionMarketIds: [fixture.id]
                };
                const rejectionVersionKeys = [
                    fixture.id,
                    defaultGroupVersionKey(fixture.id),
                    ...fixture.stages.map((stage) => stage.id)
                ];
                await waitForExpectedRecordsToExist(
                    documentClient,
                    cleanupState.records
                );
                await Promise.all([
                    waitForCapabilities(
                        documentClient,
                        cleanupState.capabilityIds,
                        (items) => hasActiveCapability(
                            items,
                            adminUser.id
                        ),
                        'Rejection fixture capabilities were not created'
                    ),
                    waitForVersionKeys(
                        documentClient,
                        fixture.id,
                        rejectionVersionKeys
                    )
                ]);
                await documentClient.update({
                    TableName: TABLES.markets,
                    Key: { id: fixture.id },
                    UpdateExpression: 'REMOVE #subType',
                    ConditionExpression: [
                        '#name = :name',
                        '#accountId = :accountId',
                        '#createdBy = :createdBy',
                        '#objectType = :normal',
                        '#subType = :integrationTest'
                    ].join(' AND '),
                    ExpressionAttributeNames: {
                        '#name': 'name',
                        '#accountId': 'account_id',
                        '#createdBy': 'created_by',
                        '#objectType': 'object_type',
                        '#subType': 'market_sub_type'
                    },
                    ExpressionAttributeValues: {
                        ':name': fixture.name,
                        ':accountId': fixture.accountId,
                        ':createdBy': fixture.createdBy,
                        ':normal': NORMAL_OBJECT_TYPE,
                        ':integrationTest': INTEGRATION_TEST_SUB_TYPE
                    }
                }).promise();

                let rejection;
                try {
                    rejection = await invokeDelete(
                        lambda,
                        fixture.id
                    );
                } finally {
                    // Restore the deletion guard immediately, even when the
                    // invocation fails or the rejection assertion below does.
                    await makeFixtureDeletable(
                        documentClient,
                        fixture
                    );
                }
                assert.strictEqual(rejection.statusCode, 403);
                assert.deepStrictEqual(rejection.body, {
                    error_message:
                        'Hard deletion is only allowed for top-level demo or test planning markets'
                });
                const restoredMarket = await getItem(
                    documentClient,
                    TABLES.markets,
                    fixture.id
                );
                assert(restoredMarket, 'Rejected market was deleted');
                assert.strictEqual(
                    restoredMarket.object_type,
                    NORMAL_OBJECT_TYPE
                );
                assert.strictEqual(
                    restoredMarket.market_sub_type,
                    INTEGRATION_TEST_SUB_TYPE
                );
                await Promise.all([
                    waitForExpectedRecordsToExist(
                        documentClient,
                        cleanupState.records
                    ),
                    waitForCapabilities(
                        documentClient,
                        cleanupState.capabilityIds,
                        (items) => hasActiveCapability(
                            items,
                            adminUser.id
                        ),
                        'Rejection mutated fixture capabilities'
                    ),
                    waitForVersionKeys(
                        documentClient,
                        fixture.id,
                        rejectionVersionKeys
                    )
                ]);
            } finally {
                // makeFixtureDeletable uses a conditional update tied to this
                // exact fixture before invoking the guarded cascade.
                await deleteFixtureIfPresent(
                    documentClient,
                    lambda,
                    fixture
                );
                await waitForCleanupState(
                    documentClient,
                    cleanupState
                );
            }
        }).timeout(900000);
    });
}
