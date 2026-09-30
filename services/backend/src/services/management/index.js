// D1 assembly entry for the management subsystem. Replaces the former pure
// re-export shell: custom-providers ops deps are bound here so the D2 resource
// module holds no require into D1 ([RESEARCH-018] P2 cut-set E1-E3, gate
// d2-no-reach-into-d1). Keep this file as the single assembly point.
const customProvidersResource = require('../domain/project/management/resources/customProviders.resource');

customProvidersResource.bind({
  pool: require('../apiKeyPool'),
  registrar: require('../customProviderRegistrar'),
  registry: require('../customProviderRegistry'),
});

module.exports = require('../domain/project/management');
