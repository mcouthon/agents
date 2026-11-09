---
name: testing
description: "Behavioral testing strategy — deciding what to test and how. Use when writing tests, reviewing test quality, or fixing tests that test mocks instead of behavior. Triggers on: 'use testing mode', 'write tests', 'test strategy', 'tests are brittle', 'tests test mocks', 'improve test quality', 'what should I test'. Full access mode - can write and run tests."
allowed-tools: [Read, Edit, Write, Bash, Grep, Glob, LSP]
---

# Testing Strategy

Decide what to test and how to test it. Write tests that catch real regressions.

> "Tests should be coupled to the behavior of code and decoupled from the structure of code." — Kent Beck

## The Self-Test

Ask these 5 questions about EVERY test you write. If any answer is "no", rewrite the test.

| #   | Question                                                  | What It Checks         |
| --- | --------------------------------------------------------- | ---------------------- |
| 1   | Could I rewrite the internals and this test still passes? | Structure-insensitive  |
| 2   | Am I testing what the code SHOULD DO, not what it DOES?   | Behavioral             |
| 3   | If this test passes, do I trust the code works?           | Predictive / Inspiring |
| 4   | Am I testing through the public API?                      | Public contract        |
| 5   | Am I checking state/output, not verifying call sequences? | State > Interaction    |

**The Refactoring Litmus Test**: After writing a test, imagine completely rewriting the internals while keeping the same public behavior. Would the test still pass? If not, it's coupled to structure and will become a maintenance burden.

## Test Double Decision Tree

Choose the simplest test double that gives confidence. Work top to bottom — stop at the first "yes".

```
Can I use the REAL implementation?
├─ Yes → Use it (always the first choice)
└─ No → Is it slow, non-deterministic, or expensive?
         ├─ Yes → Is a FAKE available? (in-memory DB, fake server)
         │        ├─ Yes → Use the fake
         │        └─ No → STUB specific return values (keep count low)
         └─ No → Do I need to verify external SIDE EFFECTS?
                  (email sent, record saved, event published)
                  ├─ Yes → Interaction test with verify (LAST RESORT)
                  └─ No → Re-examine — you probably CAN use the real thing
```

### When to Mock

**Mock AT boundaries (external edges of your system):**

- External HTTP APIs → fake server or stub responses
- Databases → in-memory DB, fake repository, or testcontainers
- File system → in-memory FS or temp directories
- System clock → inject controllable clock
- Non-deterministic sources → seeded random, fixed UUIDs
- Expensive third-party calls → stub at the adapter layer

**Never mock these:**

- Internal collaborator classes
- Value objects or data structures
- Pure functions or utilities
- Anything you can instantiate cheaply

**"Don't Mock What You Don't Own"**: If you must mock a third-party API, wrap it in your own adapter and mock the adapter.

## What to Test

Think in **behaviors**, not methods. Each test covers one behavior: "Given X, when Y, then Z."

### How Many Tests

Count follows exposure, not habit — no more to fill a suite, no less to dodge work:

- **Findings:** every bug or exercise break gets its regression test — the failing test
  that reproduces what you observed. No exceptions.
- **New behavior:** what the request exercises. A behavior nobody named and nothing
  exposed earns no test.
- **Edge cases:** only where failure is plausible and costly — bad input at a trust
  boundary, empty state a real caller can produce. Not every branch, not every guard.

A pasted command with its real output proves the change works now; a test proves it
keeps working. Write both for what execution exposed — then stop.

### Identify Behaviors

Don't write one test per method. When a behavior earns a test (How Many Tests), make it
exactly one behavior:

```python
# BAD — one method, one test (grows unwieldy)
def test_process_transaction():
    # tests display, validation, AND balance check in one test
    ...

# GOOD — one behavior, one test
def test_process_transaction_rejects_negative_amount(): ...
```

The GOOD line shows how to slice, not how many to write: three behaviors in one method
does not owe three tests unless they were named or exposed.

### Priority Order

1. **Regressions** — tests for bugs and exercise findings; they lock known-real breaks
2. **Named behaviors** — what the request exercises: the rules, invariants and
   boundaries it lives on
3. **Plausible, costly edges** — where failure is believable and expensive, not every
   branch
4. **Everything else** — the obvious happy path, defensive guards nobody can reach

### Usually Skip

Third-party library internals, simple getters/setters, framework boilerplate, and implementation details that may change.

### Bug Fixes

Always write a failing test FIRST that reproduces the bug. Then fix it. Never fix a bug without a regression test.

A failure you found by exercising the code by hand is a bug like any other — reproduce the observed failure in a failing test before fixing it, then re-exercise by hand to confirm.

## Anti-Patterns: Before and After

### 1. Over-Mocking → Use Real Implementations

```python
# BEFORE — testing mocks, not code
@patch("myapp.cache.get")
@patch("myapp.db.query")
@patch("myapp.validator.check")
def test_process(mock_check, mock_cache, mock_db):
    mock_db.return_value = {"id": 1}
    mock_cache.return_value = None
    mock_check.return_value = True
    result = process(1)  # What are we even testing?
    assert result == {"id": 1}

# AFTER — test with real collaborators
def test_process():
    db = InMemoryDatabase({"users": [{"id": 1, "name": "Alice"}]})
    service = ProcessingService(db=db, cache=MemoryCache())
    result = service.process(1)
    assert result.name == "Alice"
```

### 2. Mirror Tests → Test Outcomes, Not Steps

```python
# BEFORE — mirrors implementation step by step
def test_register_user():
    service.register("alice@test.com", "pass123")
    mock_validator.validate.assert_called_once_with("alice@test.com")
    mock_db.insert.assert_called_once()
    mock_email.send.assert_called_once_with(
        to="alice@test.com", template="welcome"
    )

# AFTER — asserts observable outcomes
def test_register_user():
    service.register("alice@test.com", "pass123")
    assert service.get_user("alice@test.com") is not None  # user exists
    assert len(email_server.sent) == 1                      # email sent
    assert email_server.sent[0].to == "alice@test.com"
```

## Writing Good Tests

### Naming Conventions

Describe **what scenario** is tested and **what outcome** is expected:

```python
# Good — scenario + expected outcome
def test_expired_token_returns_401(): ...
def test_checkout_with_empty_cart_raises_error(): ...
def test_transfer_insufficient_balance_raises_error(): ...
def test_login_wrong_password_locks_after_3_attempts(): ...
def test_search_returns_empty_list_when_no_matches(): ...

# Bad — vague, no outcome
def test_token_expiry_check(): ...
def test_transfer(): ...
def test_login_error(): ...
def test_search_works(): ...
```

### Test Structure: AAA / GWT

Structure each test as **Arrange → Act → Assert** (or **Given → When → Then**). Keep sections visually distinct — whitespace or comments between the three phases help readability.

### DAMP, Not DRY

Tests should be **Descriptive And Meaningful Phrases**. Duplicate for clarity:

- Use helper methods for **constructing** test objects (factories with sensible defaults)
- Use factory helpers like `make_user(**overrides)` to build test objects with sensible defaults — override only fields relevant to the test
- Avoid helpers that **hide what's being asserted**
- Each test should be readable without scrolling to shared setup
- Prefer explicit inline values over shared constants with ambiguous names

### No Logic in Test Bodies

Tests should be trivially correct on inspection. Straight-line code only:

- ❌ No loops, conditionals, or string concatenation in assertions
- ❌ No computed expected values
- ✅ Hardcode every expected value
- ✅ One clear path from setup → action → assertion

## Test Quality Checklist

Before committing tests, verify each one:

```markdown
- [ ] Passes the 5-question Self-Test (above)
- [ ] Name describes scenario + expected outcome
- [ ] No logic (loops, conditionals) in test body
- [ ] Each test is self-contained (DAMP: readable without shared context)
- [ ] Failure message tells you what's wrong without reading the test
- [ ] Uses real implementations where possible (mocks only at boundaries)
- [ ] Tests behavior through public API, not internal methods
```

## Rationalization Prevention

| Excuse                                 | Reality                                         | Required Action                                                                                 |
| -------------------------------------- | ----------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| "The change is too small to test"      | Size is not the axis — exposure is              | Nothing exposed, nothing named → no test owed; still exercise the change and show the output    |
| "Tests are passing"                    | You haven't actually run them                   | Run the test suite and show output                                                              |
| "Existing tests cover this"            | You haven't checked                             | Find and cite the specific test                                                                 |
| "I'll add tests later"                 | Later never comes — for tests that are owed     | Write the tests How Many Tests says are owed, before marking done                               |
| "Mocking is too complex here"          | Complex mocking means bad design                | Refactor to test real behavior instead                                                          |
| "This is just a prototype"             | Prototypes without tests become production code | Regression tests for what execution exposed, now; forward tests when it stops being a prototype |
| "I found it by hand, I'll just fix it" | An unfixed-in-tests bug comes back              | Write the failing test that reproduces what you observed, then fix                              |
