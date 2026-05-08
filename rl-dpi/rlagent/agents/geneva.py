"""Geneva-style genetic algorithm baseline.

A minimal port of the Bock 2019 (CCS) idea to our action grammar:
each individual is a *chain* (list of action IDs from the catalogue),
and standard GA ops (selection, crossover, mutation) evolve the
population. This is the published baseline RL must beat.

Note: this reuses our `mutations.CATALOG` because it's the same primitive
set. The chain is materialised by composing the plans of each action in
sequence into one combined Plan (chunks concatenated, max delay).
"""
from __future__ import annotations
import random
from dataclasses import dataclass, field
from typing import Optional

import numpy as np

from ..envs import mutations


@dataclass
class _Individual:
    chain: list[int]
    fitness: float = 0.0
    n_evals: int = 0


def _compose(chain: list[int], sni: str) -> mutations.Plan:
    """Glue the plans of chain[0..k] into one combined Plan."""
    if not chain:
        return mutations.get(0, sni)
    first = mutations.get(chain[0], sni)
    chunks = list(first.chunks)
    delay = first.delay_between_ms
    pre_byte = first.pre_connect_byte
    cost = first.cost
    for a in chain[1:]:
        p = mutations.get(a, sni)
        chunks.extend(p.chunks)
        delay = max(delay, p.delay_between_ms)
        pre_byte = pre_byte or p.pre_connect_byte
        cost += p.cost * 0.5  # discount stacked cost a bit
    return mutations.Plan(chunks=chunks, delay_between_ms=delay,
                          pre_connect_byte=pre_byte,
                          name="genv:" + "+".join(str(a) for a in chain),
                          cost=cost)


class GenevaAgent:
    name = "geneva"

    def __init__(self, n_actions: int, pop_size: int = 32,
                 max_chain_len: int = 4, mutation_rate: float = 0.2,
                 crossover_rate: float = 0.5, seed: int = 0) -> None:
        self.n_actions = n_actions
        self.pop_size = pop_size
        self.max_chain_len = max_chain_len
        self.mutation_rate = mutation_rate
        self.crossover_rate = crossover_rate
        self.rng = random.Random(seed)

        self.population: list[_Individual] = [
            self._random_individual() for _ in range(pop_size)
        ]
        self._eval_idx = 0
        self._generation = 0

    def _random_individual(self) -> _Individual:
        L = self.rng.randint(1, self.max_chain_len)
        chain = [self.rng.randint(0, self.n_actions - 1) for _ in range(L)]
        return _Individual(chain=chain)

    def act(self, obs: np.ndarray) -> tuple[int, list[int]]:
        """Return (representative_action_for_logging, chain_to_compose)."""
        ind = self.population[self._eval_idx % self.pop_size]
        return ind.chain[0], list(ind.chain)

    def update(self, obs, action, reward, next_obs, done) -> None:
        ind = self.population[self._eval_idx % self.pop_size]
        ind.fitness = (ind.fitness * ind.n_evals + reward) / (ind.n_evals + 1)
        ind.n_evals += 1
        self._eval_idx += 1
        if self._eval_idx % self.pop_size == 0:
            self._evolve()
            self._generation += 1

    # ---- evolution ----

    def _evolve(self) -> None:
        # Tournament selection
        def pick() -> _Individual:
            return max(self.rng.sample(self.population, 3), key=lambda x: x.fitness)

        new_pop: list[_Individual] = []
        # Elitism: keep top-2
        sorted_pop = sorted(self.population, key=lambda x: x.fitness, reverse=True)
        new_pop.extend(_Individual(chain=list(sorted_pop[i].chain),
                                   fitness=sorted_pop[i].fitness,
                                   n_evals=sorted_pop[i].n_evals)
                       for i in range(2))
        while len(new_pop) < self.pop_size:
            p1, p2 = pick(), pick()
            if self.rng.random() < self.crossover_rate and len(p1.chain) > 1 and len(p2.chain) > 1:
                cx = self.rng.randint(1, min(len(p1.chain), len(p2.chain)) - 1)
                child = _Individual(chain=p1.chain[:cx] + p2.chain[cx:])
            else:
                child = _Individual(chain=list(p1.chain))
            # mutation
            for i in range(len(child.chain)):
                if self.rng.random() < self.mutation_rate:
                    child.chain[i] = self.rng.randint(0, self.n_actions - 1)
            if self.rng.random() < self.mutation_rate / 2 and len(child.chain) < self.max_chain_len:
                child.chain.append(self.rng.randint(0, self.n_actions - 1))
            if self.rng.random() < self.mutation_rate / 2 and len(child.chain) > 1:
                child.chain.pop(self.rng.randint(0, len(child.chain) - 1))
            new_pop.append(child)
        self.population = new_pop

    def best(self) -> _Individual:
        return max(self.population, key=lambda x: x.fitness)

    def state_dict(self) -> dict:
        return {"pop": [(i.chain, i.fitness, i.n_evals) for i in self.population],
                "gen": self._generation}

    def load_state_dict(self, sd: dict) -> None:
        self.population = [_Individual(chain=list(c), fitness=f, n_evals=n)
                           for (c, f, n) in sd["pop"]]
        self._generation = sd["gen"]
