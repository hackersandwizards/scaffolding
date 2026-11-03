---
name: architecture-principles
description: >-
  h&w's standard for client systems, to review architecture or code ("red flags"), choose a
  design ("microservices or monolith", "build or buy"), argue a technical position in a proposal
  or training, or diagnose "why is this team slow", never for routine work in an existing codebase.
---

# Architecture Principles for Client Systems

## Core Philosophy

- Architecture exists to split work between teams so they can ship independently. If it doesn't serve coordination, it's ornamental.
- Principles over rules in complex environments: teach judgment.
- Code changeability matters more than code correctness. "It is more important for code to be changeable than that it work."
- The Three Ways: Fast Flow, Fast Feedback, Continuous Learning
- Five Ideals: Locality/Simplicity, Focus/Flow/Joy, Improvement of Daily Work, Psychological Safety, Customer Focus

## Engineering Values

1. **Tech follows Business**: business value drives all technical decisions. A running system with minimal functions is more valuable than discussing concepts.
2. **Move fast, fail fast**: short build-measure-learn cycles, Conway's Law, MTTR over MTBF.
3. **Low technical barriers**: standardization, open standards, knowledge exchange across teams.
4. **Coverage of non-functional aspects**: security, performance, resilience, quality pyramid.
5. **Full ownership and clear responsibility**: you build it, you run it. Everything in production must be owned.
6. **Retained expertise in core technologies**: AI accelerates engineering, it does not transfer architecture ownership or domain accountability. Delegate implementation, never understanding.

## Architecture Principles

- **Bounded Contexts and Vertical Systems**: DDD-aligned. Own data, business logic, and UI per context. Communication via domain events.
- **Non-Blocking Communication**: events over synchronous calls. Design for eventual consistency.
- **Small and Simple**: microservices sized to team capacity, not nano-services. Every new service is tech debt until proven otherwise.
- **Evolutionary Architecture**: defer accidental complexity. Sacrificial architecture is a valid pattern.
- **Cloud Native**: 12-factor apps, infrastructure as code, immutable deployments.
- **Scale Horizontally**: stateless services, shared-nothing, scale via instances not bigger machines.
- **Continuous Delivery and Deployment**: fully automated pipelines, trunk-based development, deploy on every green build.
- **Sensible Defaults**: technology radar, minimize variation. Freedom within constraints.
- **Use Low-Tech Coupling**: DNS, HTTP, JSON, event streaming.
- **Make Decisions in Public**: RFCs and ADRs that record the why.
- **Security First**: TLS everywhere, threat modeling, security by default, shift left.

## Design red flags (Ousterhout)

Shallow modules, information leakage, temporal decomposition, overexposure, pass-through methods,
repetition, special-general mixture, conjoined methods, comment repeats code, implementation
contaminates interface, vague names, hard to pick names, hard to describe, nonobvious code.

## Diagnostic patterns

**Architecture anti-patterns:** tight coupling between systems, missing test environments, manual
deployments, shared databases across team boundaries, monolithic frontends, no domain events.

**Process waste:** missing focus, excessive context switching, long wait times, heroism culture,
knowledge silos, meeting overload, approval bottlenecks, oversized work packages, unfinished
tickets, unnecessary process gates, scope creep and gold plating, excessive handoffs, bugs as
unplanned work, manual toil that should be automated.

**Systemic issues:** poor code craftsmanship, missing domain understanding, missing systems
thinking, no experimentation culture, no learning culture, security as an afterthought.

**Build or buy:** evaluate Functional Complexity, Technical Complexity, Operational Complexity,
and Unique Business Value. Then run the 5-level cost analysis: License, Integration, Operation,
Opportunity, Migration.

## Techniques > Principles > Practices

For training content and proposals that need the full vocabulary.

**Techniques** (how we approach work): Iteration, Feedback, Incrementalism, Experimentation,
Empiricism

**Principles** (what guides decisions): Customer Centricity, Assure Speed By Quality, Design For
Testability, Shift Left On Security, Share Nothing, Couple Loosely, Build Reactively, Deploy
Continuously, Separate Concerns, Run Observable, Be Agile, Don't Reinvent, Avoid Middle Road,
Continuous Alignment, YAGNI, Working Backwards

**Practices** (what we do daily): Small Empowered Teams, Mob Programming, Release Spike ASAP,
Trunk-Based Development, Feature Flags, Self-Contained Systems, Micro Frontends, Server Side
Includes, HTML over the Wire, API First, Cloud Native, DDD, Reactive Programming, Functional
Programming, Shared Pattern Library, Feeds & Snapshots, Security Belt, OAuth, TLS Everywhere,
Runbooks, Chaos Testing, Static Code Analysis, Event Storming, Context Mapping, Team Topologies,
Arc42, Cost Optimization
