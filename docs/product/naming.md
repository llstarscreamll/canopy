# Naming

Canopy is the habitat. Products that live in it have their own names.

## Canopy (Spanish: Canopia)

The forest canopy of the tropical rainforest, where the most diverse
bird species converge and nest. As habitat, it hosts a wide variety of
animals, insects, and epiphytes (such as orchids) that live in the
heights.

In this repo, Canopy is the **monorepo**: shared toolchain, packages,
and layout. It is not a commercial product. It is the place where
several commercial systems nest.

| Layer        | Name   | Examples                                    |
| ------------ | ------ | ------------------------------------------- |
| Habitat      | Canopy | Root package `canopy`, `@canopy/*`, `pkg/`  |
| Product      | Atta   | `apps/atta`, `@atta/*`, `github.com/atta`   |
| Future nests | —      | threehopper, kinglet, bowerbird, and others |

`bowerbird` is reserved as a **future product** name. Do not reuse it
for Canopy or Atta.

## Atta (leafcutter ant)

The reference model for supply chains in nature. Colonies work with
role division, optimize transport routes, and manage massive underground
inventories without margin for error.

Atta is the **current commercial system**: inbound invoicing, catalog,
inbox, and related product surfaces under `apps/atta`.

Local Atta origins:

- App and API: `https://app.atta.dev`
- Media: `https://media.atta.dev`

## Package namespaces

| Kind                       | Namespace                                                                | Path                        |
| -------------------------- | ------------------------------------------------------------------------ | --------------------------- |
| Habitat npm root           | `canopy`                                                                 | `/package.json`             |
| Shared TypeScript          | `@canopy/<pkg>`                                                          | `packages/typescript/<pkg>` |
| Shared Go (when extracted) | `canopy/pkg/<pkg>`                                                       | `pkg/<pkg>`                 |
| Atta product SemVer        | `@atta/product`                                                          | `apps/atta`                 |
| Atta backend (Go module)   | `github.com/atta`                                                        | `apps/atta/backend`         |
| Atta npm apps              | `@atta/backend`, `@atta/pwa`, `@atta/e2e`, `@atta/infra`, `@atta/onprem` | `apps/atta/*`               |

Add a new commercial system as `apps/<product>/` with its own backend,
pwa, desktop, mobile, and deploy trees. Do not fold product code into
Canopy shared packages until it is stable and used by more than one
system.

Layout: [Monorepo layout](../technical/architecture/monorepo.md).
Versioning: [Product versioning](../technical/architecture/product-versioning.md).
