"""The repository's conftest: pytest reads it before any test."""
import pytest


def pytest_configure(config):
    config.addinivalue_line("markers", "slow: a test that talks to a carrier")
