from contextlib import asynccontextmanager
import uuid
from .config import BudgetPaused


class Budget:
    def __init__(self, store, job_id, worker_id):
        self.store, self.job_id, self.worker_id = store, job_id, worker_id

    @asynccontextmanager
    async def reserve(self, reservation_id: str, ceiling: float):
        reservation_id = f'{reservation_id}/{uuid.uuid4()}'
        ceiling = round(ceiling + 0.000001, 6)
        accepted = await self.store.rpc('reserve_job_cost', p_job_id=self.job_id,
            p_worker_id=self.worker_id, p_reservation_id=reservation_id, p_amount=ceiling)
        if not accepted:
            raise BudgetPaused('The next stage exceeds the remaining $25 generation budget.')
        settlement = {'actual': ceiling}
        try:
            yield settlement
        finally:
            # An uncertain request is charged at its reserved ceiling. A crash leaves
            # the reservation held in SQL; each paid retry gets a new attempt ID.
            await self.store.rpc('settle_job_cost', p_job_id=self.job_id,
                p_worker_id=self.worker_id, p_reservation_id=reservation_id,
                p_actual=max(0, settlement['actual']))
            if settlement['actual'] > ceiling + .00001:
                raise BudgetPaused('Measured cost exceeded its configured ceiling. Processing paused; verify provider pricing before continuing.')
