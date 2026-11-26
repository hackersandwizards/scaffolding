# Layers

```mermaid
graph LR
  L0["."]
  L1[".githooks"]
  L2["bin"]
  L3["catalog"]
  L4["config, lib"]
  L5["template"]
  L6["test"]
  L0 -->|1| L4
  L2 -->|5| L0
  L2 -->|83| L4
  L3 -->|3| L4
  L4 -->|2| L5
  L6 -->|3| L0
  L6 -->|1| L1
  L6 -->|1| L2
  L6 -->|30| L3
  L6 -->|113| L4
  L6 -->|6| L5
```

## config, lib

| Forbidden import | Message                                                                 |
| ---------------- | ----------------------------------------------------------------------- |
| `^(\.\./)+bin/`  | `Keep command entry points in bin. Put reusable code in lib or config.` |
