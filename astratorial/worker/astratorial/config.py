from dataclasses import dataclass


class ProvisioningError(RuntimeError):
    pass


class BudgetPaused(RuntimeError):
    pass


@dataclass(frozen=True)
class Config:
    supabase_url: str
    supabase_key: str
    openai_key: str
    model: str
    rates: dict
    app_url: str
    worker_token: str
