---
applyTo: "**/*.py"
---

# Python Coding Standards

## Formatting

- Use 4 spaces for indentation (no tabs)
- Maximum line length: 88 characters (Black default)
- Use trailing commas in multi-line structures
- Blank lines: 2 between top-level definitions, 1 within classes

## Type Hints

- All function signatures must include type hints
- Use `from __future__ import annotations` for forward references
- Prefer modern syntax: `list[str]` over `List[str]`, `dict[str, int]` over `Dict[str, int]`
- Use `|` for unions: `str | None` over `Optional[str]`
- Complex types go in a `types.py` or use `TypeAlias`

```python
# Good
def process(items: list[str], config: Config | None = None) -> dict[str, Result]:
    ...

# Avoid
def process(items, config=None):
    ...
```

## Imports

- Group: stdlib → third-party → local (blank line between groups)
- Use absolute imports for clarity
- Avoid wildcard imports (`from module import *`)
- Sort alphabetically within groups

```python
import os
from pathlib import Path

import pydantic
from fastapi import FastAPI

from myapp.config import Settings
from myapp.models import User
```

## Error Handling

- Never use bare `except:`
- Catch specific exceptions
- Log with context before re-raising
- Use custom exceptions for domain errors

```python
# Good
try:
    result = api.fetch(endpoint)
except requests.Timeout as e:
    logger.warning(f"Timeout fetching {endpoint}: {e}")
    raise ServiceUnavailableError(f"API timeout: {endpoint}") from e

# Bad
try:
    result = api.fetch(endpoint)
except:
    pass
```

## Functions and Classes

- Functions should do one thing
- Aim for < 30 lines per function
- Use dataclasses or Pydantic for data containers
- Prefer composition over inheritance

```python
# Good - clear, typed, single purpose
@dataclass
class UserConfig:
    name: str
    email: str
    active: bool = True

def validate_email(email: str) -> bool:
    return "@" in email and "." in email.split("@")[1]

# Avoid - mutable default, no types
class User:
    def __init__(self, data={}):
        self.data = data
```

## Documentation

- Docstrings for public functions and classes
- Use Google style docstrings
- Document exceptions raised
- Skip docstrings for obvious single-purpose private functions

```python
def calculate_tax(amount: Decimal, rate: Decimal) -> Decimal:
    """Calculate tax amount.

    Args:
        amount: Base amount to tax.
        rate: Tax rate as decimal (e.g., 0.08 for 8%).

    Returns:
        Calculated tax amount, rounded to 2 decimal places.

    Raises:
        ValueError: If rate is negative.
    """
    if rate < 0:
        raise ValueError(f"Tax rate cannot be negative: {rate}")
    return (amount * rate).quantize(Decimal("0.01"))
```

## Testing

- Use pytest as the test framework
- Test files: `test_<module>.py` or `<module>_test.py`
- Use fixtures for setup/teardown
- Aim for clear arrange-act-assert structure

```python
def test_calculate_tax_standard_rate():
    # Arrange
    amount = Decimal("100.00")
    rate = Decimal("0.08")

    # Act
    result = calculate_tax(amount, rate)

    # Assert
    assert result == Decimal("8.00")
```

## Async

- Prefer `async/await` for I/O-bound operations
- Use `asyncio.gather` for concurrent operations
- Avoid mixing sync and async code
- Use `async with` for context managers in async code

## Common Patterns

### Configuration

```python
from pydantic_settings import BaseSettings

class Settings(BaseSettings):
    database_url: str
    api_key: str
    debug: bool = False

    class Config:
        env_prefix = "APP_"
```

### Logging

```python
import structlog

logger = structlog.get_logger(__name__)

def process_order(order_id: str) -> None:
    logger.info("processing_order", order_id=order_id)
```
