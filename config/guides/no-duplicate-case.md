# Two `case` labels in this `switch` check the same value, leaving the second unreachable.

Check the switch input and tests to see whether the second body belongs to a different case or repeats the first. Fix the duplicate label to the intended distinct value, or merge and delete it only after checking its body.

No fix: hiding the same value behind a named constant, or deleting an unreachable `case` without checking its body.
