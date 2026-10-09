"""Multinomial Naive Bayes text classifier, pure Python (no external AI service or API key).

Trained locally on ticket text. Predictions come with a confidence score and the
words that pushed the decision, so every suggestion can be explained.
"""
from __future__ import annotations

import math
import random
import re
from collections import Counter, defaultdict
from dataclasses import dataclass, field

STOPWORDS = {
    "a", "an", "and", "are", "as", "at", "be", "been", "but", "by", "can", "cant", "could", "do", "does", "for", "from",
    "had", "has", "have", "i", "in", "is", "it", "its", "me", "my", "of", "on", "or", "our", "please", "since", "so",
    "that", "the", "their", "there", "this", "to", "too", "up", "was", "we", "when", "with", "you", "your", "im", "ive",
    "just", "any", "all", "get", "got", "into", "also", "now", "one", "some", "still", "today", "help", "hi", "hello",
    "thanks", "thank", "synthetic", "demonstration", "generated", "demo", "environment", "campus",
}
_WORD = re.compile(r"[a-z0-9]+")


def tokenize(text: str) -> list[str]:
    words = []
    for w in _WORD.findall(text.lower().replace("wi-fi", "wifi").replace("e-mail", "email")):
        if w in STOPWORDS or len(w) < 2:
            continue
        if len(w) > 4 and w.endswith("s") and not w.endswith("ss"):
            w = w[:-1]  # light stemming: printers -> printer
        words.append(w)
    bigrams = [f"{a}_{b}" for a, b in zip(words, words[1:])]
    return words + bigrams


@dataclass
class Prediction:
    label: str
    confidence: float
    ranking: list[tuple[str, float]]
    evidence: list[str] = field(default_factory=list)


class NaiveBayes:
    def __init__(self, alpha: float = 0.5):
        self.alpha = alpha
        self.class_docs: Counter = Counter()
        self.word_counts: dict[str, Counter] = defaultdict(Counter)
        self.class_words: Counter = Counter()
        self.vocab: set[str] = set()

    def fit(self, docs: list[tuple[list[str], str]]) -> "NaiveBayes":
        for tokens, label in docs:
            self.class_docs[label] += 1
            for t in tokens:
                self.word_counts[label][t] += 1
                self.class_words[label] += 1
                self.vocab.add(t)
        return self

    @property
    def labels(self) -> list[str]:
        return sorted(self.class_docs)

    def _loglik(self, label: str, token: str) -> float:
        v = len(self.vocab) or 1
        return math.log((self.word_counts[label][token] + self.alpha) / (self.class_words[label] + self.alpha * v))

    def predict(self, tokens: list[str]) -> Prediction:
        if not self.class_docs:
            raise ValueError("model is not trained")
        known = [t for t in tokens if t in self.vocab]
        total = sum(self.class_docs.values())
        scores = {c: math.log(self.class_docs[c] / total) + sum(self._loglik(c, t) for t in known) for c in self.labels}
        # Naive Bayes is overconfident on long texts; temper the scores by text length (a simple calibration).
        temp = max(1.0, len(known) / 3)
        top = max(scores.values())
        exps = {c: math.exp((s - top) / temp) for c, s in scores.items()}
        z = sum(exps.values())
        ranking = sorted(((c, e / z) for c, e in exps.items()), key=lambda x: -x[1])
        best = ranking[0][0]
        runner = ranking[1][0] if len(ranking) > 1 else best
        # Evidence: the words that favour the winning class most over the runner-up.
        contrib = sorted({t for t in known if "_" not in t},
                         key=lambda t: self._loglik(best, t) - self._loglik(runner, t), reverse=True)
        evidence = [t for t in contrib if self._loglik(best, t) - self._loglik(runner, t) > 0.3][:5]
        return Prediction(best, ranking[0][1], ranking, evidence)


def cross_validate(docs: list[tuple[list[str], str]], folds: int = 5, seed: int = 7) -> float | None:
    """k-fold accuracy, or None when there's too little data to say anything."""
    if len(docs) < folds * 4 or len({label for _, label in docs}) < 2:
        return None
    shuffled = docs[:]
    random.Random(seed).shuffle(shuffled)
    correct = 0
    for k in range(folds):
        test = shuffled[k::folds]
        train = [d for i, d in enumerate(shuffled) if i % folds != k]
        model = NaiveBayes().fit(train)
        correct += sum(1 for tokens, label in test if model.predict(tokens).label == label)
    return round(100 * correct / len(shuffled), 1)
