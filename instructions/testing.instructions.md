---
applyTo: "**/*{test,spec}*.{py,ts,tsx,js}"
---

# Testing Standards

## Philosophy

- **Tests are documentation** - A reader should understand the feature from tests
- **Test behavior, not implementation** - Don't test private methods directly
- **One assertion concept per test** - Multiple asserts are OK if testing one behavior
- **Tests must be reliable** - Flaky tests are worse than no tests

## Test Structure

### Arrange-Act-Assert (AAA)

```python
def test_user_registration_sends_welcome_email():
    # Arrange - set up preconditions
    email_service = MockEmailService()
    user_service = UserService(email=email_service)

    # Act - perform the action
    user_service.register("alice@example.com", "password123")

    # Assert - verify the outcome
    assert email_service.sent_count == 1
    assert email_service.last_recipient == "alice@example.com"
```

### Given-When-Then (for BDD style)

```python
def test_checkout_applies_discount_code():
    """
    Given a cart with items totaling $100
    When a 20% discount code is applied
    Then the total should be $80
    """
    cart = Cart(items=[Item(price=100)])

    cart.apply_discount("SAVE20")

    assert cart.total == 80
```

## Naming Conventions

- **Describe what, not how**: `test_expired_token_returns_401` not `test_token_expiry_check`
- **Include context**: `test_checkout_with_empty_cart_raises_error`
- **Be specific**: `test_user_email_validated` not `test_user`

```python
# Good
def test_transfer_insufficient_balance_raises_error():
def test_login_wrong_password_locks_after_3_attempts():
def test_search_returns_empty_list_when_no_matches():

# Avoid
def test_transfer():
def test_login_error():
def test_search_works():
```

## Fixtures and Setup

- Use fixtures/setup for common arrangements
- Keep fixtures focused and composable
- Avoid global state between tests

```python
# pytest example
@pytest.fixture
def authenticated_client(db_session):
    user = create_test_user(db_session)
    client = TestClient(app)
    client.login(user)
    return client

def test_profile_update(authenticated_client):
    response = authenticated_client.patch("/profile", json={"name": "New"})
    assert response.status_code == 200
```

## Mocking Guidelines

- Mock at boundaries (external services, databases, time)
- Don't mock the system under test
- Verify mock interactions when behavior matters
- Reset mocks between tests

```python
# Good - mock external dependency
@patch("myapp.services.email.send_email")
def test_registration_sends_email(mock_send):
    register_user("alice@example.com")
    mock_send.assert_called_once_with(
        to="alice@example.com",
        template="welcome"
    )

# Avoid - mocking internal implementation
@patch("myapp.services.user._validate_password")  # Don't mock internals
def test_registration(mock_validate):
    ...
```

## Test Data

- Use factories or builders for complex objects
- Keep test data minimal but realistic
- Don't share mutable test data between tests

```python
# Factory pattern
def make_user(**overrides) -> User:
    defaults = {
        "email": "test@example.com",
        "name": "Test User",
        "active": True,
    }
    return User(**{**defaults, **overrides})

def test_inactive_user_cannot_login():
    user = make_user(active=False)
    assert not user.can_login()
```

## Async Testing

- Use appropriate async test runners
- Don't mix sync and async test utilities
- Set reasonable timeouts

```python
# pytest-asyncio
@pytest.mark.asyncio
async def test_concurrent_requests():
    async with AsyncClient(app) as client:
        responses = await asyncio.gather(
            client.get("/endpoint"),
            client.get("/endpoint"),
        )
        assert all(r.status_code == 200 for r in responses)
```

## What to Test

### Always Test

- Public API contracts
- Business logic and rules
- Error conditions and edge cases
- Security-sensitive paths
- Integration points

### Usually Skip

- Third-party library internals
- Simple getters/setters
- Framework boilerplate
- Implementation details that may change

## Test Quality Checks

Before considering tests complete:

- [ ] Tests fail when expected behavior breaks
- [ ] Tests pass consistently (not flaky)
- [ ] Test names describe the scenario
- [ ] No dependencies between test order
- [ ] Reasonable execution time (< 100ms for unit tests)
