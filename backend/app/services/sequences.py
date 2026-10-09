from __future__ import annotations

from sqlalchemy.orm import Session

from app.models import Sequence


def next_value(db: Session, name: str) -> int:
    seq = db.get(Sequence, name, with_for_update=True)
    if seq is None:
        seq = Sequence(name=name, value=0)
        db.add(seq)
    seq.value += 1
    db.flush()
    return seq.value
