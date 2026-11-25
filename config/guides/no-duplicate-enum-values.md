# Two members of this TypeScript `enum` share the same value.

Check callers, stored data, and external messages to see whether both members mean one case or two distinct values. Merge them if they mean one case, or assign the distinct value the domain expects; any value stored or sent elsewhere must keep its meaning.

No fix: changing one member to an arbitrary unused value without checking stored or sent data.
