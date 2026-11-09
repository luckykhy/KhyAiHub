// D1 assembly entry for the management subsystem. Replaces the former pure
// re-export shell: custom-providers ops deps are bound here so the D2 resource
// module holds no require into D1 ([RESEARCH-018] P2 cut-set E1-E3, gate
// d2-no-reach-into-d1). Keep this file as the single assembly point.
const customProvidersResource = require('../domain/project/management/resources/customProviders.resource');
const visionConfigResource = require('../domain/project/management/resources/visionConfig.resource');

customProvidersResource.bind({
  pool: require('../apiKeyPool'),
  registrar: require('../customProviderRegistrar'),
  registry: require('../customProviderRegistry'),
  verify: require('../gateway/customProviderVerify'),
});

// Same shape for the eyes-only vision endpoint: the store owns the declarative
// file, the pool owns the key, and neither is required by the D2 resource.
visionConfigResource.bind({
  store: require('../visionEndpointStore'),
  pool: require('../apiKeyPool'),
});

module.exports = require('../domain/project/management');
