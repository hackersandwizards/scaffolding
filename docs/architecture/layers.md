# Layers

```mermaid
graph LR
  L0["."]
  L1["bin"]
  L2["catalog"]
  L3["config, lib"]
  L4["template"]
  L5["test"]
  L0 -->|1| L3
  L1 -->|5| L0
  L1 -->|79| L3
  L2 -->|3| L3
  L3 -->|2| L4
  L5 -->|3| L0
  L5 -->|1| L1
  L5 -->|28| L2
  L5 -->|88| L3
  L5 -->|5| L4
```

## config, lib

| Forbidden import | Message                                                                 |
| ---------------- | ----------------------------------------------------------------------- |
| `^(\.\./)+bin/`  | `Keep command entry points in bin. Put reusable code in lib or config.` |
