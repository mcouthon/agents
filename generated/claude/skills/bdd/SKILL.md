---
name: bdd
description: "Behavior-Driven Development with Gherkin specifications and black-box testing. Use when working with BDD projects, writing feature files, implementing step definitions, or designing acceptance tests around observable behaviors. Triggers on: 'use bdd mode', 'bdd', 'behavior driven', 'gherkin', 'feature file', 'scenario', 'step definitions', 'acceptance test', 'given when then', 'cucumber', 'godog', 'behave', 'specflow'. Full access mode - can write feature files, step definitions, and tests."
allowed-tools: [Read, Edit, Write, Bash, Grep, Glob, LSP]
---

# BDD — Behavior-Driven Development

Write executable specifications that describe what the system does, not how it works.

> "Scenarios are not tests. They are executable specifications — living documentation of how the system behaves, written in the language of the business."

## BDD Project Detection

Proactively load this skill when any of these indicators are present:

| Indicator | What to Look For |
| --- | --- |
| Feature files | `*.feature` files anywhere in the project |
| Features directory | `features/` or `specs/` directory at project root |
| Step definitions | `*_steps.*`, `*_test.go` with godog imports, `steps/*.py` |
| BDD config | `cucumber.js`, `cucumber.yml`, `.specflow/`, `behave.ini`, `godog` in go.mod |
| Test runner config | BDD-related entries in test configuration or CI pipeline |

When detected, apply all guidance below to feature files, step definitions, and related test code.

## Feature & Scenario Organization

- **One feature per business capability** — `login.feature`, `checkout.feature`, not `everything.feature`
- **Feature title = capability** — "User Registration", not "Test the registration endpoint"
- **Scenarios describe user-observable outcomes** — what the system does, not how it's coded
- **Keep features focused** — 3–8 scenarios per feature; split if growing beyond that
- **Naming convention**: lowercase hyphens for filenames (`password-reset.feature`), Title Case for Feature/Scenario titles

```gherkin
# Good — focused feature, outcome-oriented scenarios
Feature: Password Reset
  Users can reset forgotten passwords via email

  Scenario: Successful password reset
    Given a registered user with email "alice@example.com"
    When they request a password reset
    Then a reset link is sent to "alice@example.com"

  Scenario: Reset request for unknown email
    Given no user exists with email "unknown@example.com"
    When they request a password reset for "unknown@example.com"
    Then no email is sent
    And no error is revealed to the requester
```

## Gherkin Best Practices

### Declarative Over Imperative

Describe **what happens**, not **how the user clicks through the UI**:

```gherkin
# BAD — imperative (UI mechanics)
Scenario: User logs in
  Given I am on the login page
  When I fill in "username" with "alice"
  And I fill in "password" with "secret123"
  And I click the "Login" button
  And I wait for the dashboard to load
  Then I should see "Welcome, Alice"

# GOOD — declarative (behavior)
Scenario: Successful login
  Given a registered user "alice"
  When alice logs in with valid credentials
  Then alice sees her dashboard
```

### Given / When / Then Semantics

| Keyword | Meaning | Rule |
| --- | --- | --- |
| **Given** | Precondition — system state before the action | Set up state, never assert |
| **When** | Action — the single thing being tested | One per scenario (use And for multi-step actions) |
| **Then** | Observable outcome — what changed | Assert only observable results |
| **And/But** | Continuation of the previous keyword | Same semantics as the keyword it follows |

### Background for Shared Setup

Use `Background` when most scenarios share the same preconditions:

```gherkin
Feature: Shopping Cart
  Background:
    Given a customer with an active account
    And the product catalog is loaded

  Scenario: Add item to cart
    When the customer adds "Widget" to their cart
    Then the cart contains 1 item

  Scenario: Remove item from cart
    Given the customer has "Widget" in their cart
    When they remove "Widget"
    Then the cart is empty
```

### Scenario Outlines for Data Variations

Use outlines when the same behavior applies across different inputs — never duplicate scenarios:

```gherkin
Scenario Outline: Shipping cost by region
  Given a package weighing <weight> kg
  When shipped to <region>
  Then the shipping cost is <cost>

  Examples:
    | weight | region   | cost   |
    | 1      | domestic | $5.00  |
    | 1      | europe   | $15.00 |
    | 5      | domestic | $12.00 |
```

## Black-Box Testing

BDD scenarios test through **public interfaces only** — the system is a black box:

- **API testing**: send requests, assert responses — never query the database directly
- **UI testing**: interact through the UI, assert visible state — never check DOM internals
- **Service testing**: call public methods, assert return values and observable side effects
- **No internal assertions**: never assert database rows, internal state, private methods, or implementation artifacts
- **Mock only at external boundaries**: third-party APIs, payment gateways, email services — never mock internal components

```gherkin
# BAD — reaches into implementation
Then the database contains a row in "users" with email "alice@example.com"
And the password hash starts with "$2b$"

# GOOD — asserts observable behavior
Then alice can log in with her new password
And a welcome email is received at "alice@example.com"
```

## Step Definitions

Step definitions are **thin glue code** — they translate Gherkin into application calls:

- **Call application code, don't contain logic** — a step definition should be 1–5 lines
- **Reuse steps across features** — write generic, parameterized steps
- **Keep step state in a context/world object** — not in global variables
- **One action per step** — if a step does multiple things, split it or simplify the Gherkin

```python
# GOOD — thin glue, delegates to application code
@when('the customer adds "{item}" to their cart')
def add_to_cart(context, item):
    context.response = context.client.post("/cart/items", json={"item": item})

@then('the cart contains {count:d} item(s)')
def check_cart_count(context, count):
    cart = context.client.get("/cart").json()
    assert len(cart["items"]) == count
```

```python
# BAD — logic and DB access in step definition
@when('the customer adds "{item}" to their cart')
def add_to_cart(context, item):
    product = db.query("SELECT * FROM products WHERE name = %s", (item,))
    db.execute("INSERT INTO cart_items ...")  # Direct DB manipulation!
    context.cart_count = db.query("SELECT COUNT(*) FROM cart_items ...")[0]
```

## Anti-Patterns

| Anti-Pattern | Problem | Better Approach |
| --- | --- | --- |
| **Incidental details** — "alice" with password "Str0ng!" at "9:30 AM" | Noise hides the behavior under test | Only include details relevant to the outcome |
| **Testing implementation** — Then UserService.validate() returns true | Coupled to code structure, breaks on refactor | Assert observable outcomes: "Then the user is logged in" |
| **Coupled step defs** — steps call each other or share mutable global state | Fragile chain; one change breaks many scenarios | Independent steps sharing state through a context object |
| **Scenario as test script** — 15 Given/When/Then steps in sequence | Unreadable, tests multiple behaviors at once | One behavior per scenario, 3–7 steps maximum |
| **UI-coupled steps** — "click button", "fill field", "wait for element" | Brittle, breaks on any UI change | Declarative: "When the user submits the form" |
| **Copy-paste scenarios** — same steps with different data | Maintenance burden, inconsistent updates | Scenario Outlines with Examples tables |
| **Missing Why** — Feature with no description, no business context | Can't tell if the feature is still needed | Add 1-line description under Feature explaining business value |

## Quality Checklist

Before committing feature files and step definitions:

```markdown
- [ ] Feature files are readable by non-developers
- [ ] Each scenario tests exactly one behavior
- [ ] Steps are declarative (no UI mechanics or implementation details)
- [ ] No implementation coupling (scenarios survive internal refactors)
- [ ] Step definitions are thin glue (1–5 lines, delegate to app code)
- [ ] Shared state flows through context/world object, not globals
- [ ] Scenario Outlines used for data variations (no copy-paste scenarios)
- [ ] Feature descriptions explain the business value
```

## Rationalization Prevention

| Excuse | Reality | Required Action |
| --- | --- | --- |
| "We can add scenarios later" | Missing scenarios are missing requirements | Write scenarios before implementation — they ARE the spec |
| "This is too simple for BDD" | Simple behaviors still need documented acceptance criteria | Write the feature file even if steps are trivial |
| "I'll just verify through the DB" | DB assertions couple tests to implementation | Assert through the public API/UI — black-box only |
| "One big scenario covers more" | Long scenarios test multiple behaviors and hide failures | Split into focused scenarios — one outcome each |
| "Imperative steps are more precise" | They couple to UI/implementation and break on refactor | Declarative steps describe intent, not mechanics |
| "Step reuse isn't worth the effort" | Duplicated steps diverge and create maintenance burden | Parameterize and share steps across features from day one |
