# Canopy documentation

## Run and author an app

- [Quick start and sample apps](../README.md#quick-start)
- [Local run and deployment guide (Russian)](../RUN.md)
- [Graph format reference](FORMAT.md): data, screens, actions, roles, webhooks and the JSON API
- [Generate a React frontend](../webgen/README.md): build from the graph and its OpenAPI contract

## Connect external services

- [Set up a connector](CONNECTORS.md#use-a-connector): descriptors, credentials and sandbox/live modes
- [Business connector catalog](BUSINESS-CONNECTORS.md): providers, regions and supported operations
- [Hosted checkout](PAYMENTS.md): start, confirm and refund payments
- [Data source bridge](../bridges/data-sources/README.md): external databases and opt-in writes
- [OAuth connector bridge](../bridges/oauth-connectors/README.md): OAuth-backed integrations

## Contribute and operate

- [Runtime architecture](../runtime/ARCHITECTURE.md) and [library adapters](DEPENDENCIES.md)
- [Local test guide](../TESTS.md) and [contribution guide](../CONTRIBUTING.md)
- [Release history](../CHANGELOG.md)

## Design history

These documents describe earlier decisions and experiments, not current setup instructions:

- [Connector design and implementation notes](CONNECTORS.md#design-history)
- [PostgreSQL migration design](POSTGRES.md)
- [Original project plan (Russian)](PLAN.ru.md)
- [Initial runtime slice](../SLICE.md) and [benchmark report](../REPORT.md)
