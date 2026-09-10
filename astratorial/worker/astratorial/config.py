from dataclasses import dataclass
import json
import math
import os


class ProvisioningError(RuntimeError):
    pass


class NeedsContext(RuntimeError):
    pass


class BudgetPaused(RuntimeError):
    pass


def required(name: str) -> str:
    value = os.environ.get(name, '').strip()
    if not value:
        raise ProvisioningError(f'{name} is not configured')
    return value


@dataclass(frozen=True)
class Config:
    supabase_url: str
    supabase_key: str
    openai_key: str
    model: str
    rates: dict
    app_url: str
    worker_token: str

    @classmethod
    def from_env(cls):
        # Rates are verified at provisioning, not silently guessed or read from model text.
        rates = json.loads(required('WORKER_PRICE_CEILINGS_JSON'))
        for name in ('input_million', 'output_million', 'search_call', 'cpu_second',
                     'gpu_second', 'tts_character', 'voice_input_million',
                     'voice_output_million', 'voice_text_input_million', 'voice_text_output_million'):
            if not isinstance(rates.get(name), (float, int)) or not math.isfinite(rates[name]) or rates[name] <= 0:
                raise ProvisioningError(f'Missing positive price ceiling: {name}')
        return cls(required('SUPABASE_URL').rstrip('/'), required('SUPABASE_SERVICE_ROLE_KEY'),
                   required('OPENAI_API_KEY'), required('OPENAI_MODEL'), rates,
                   required('APP_BASE_URL').rstrip('/'), required('MODAL_WORKER_TOKEN'))
