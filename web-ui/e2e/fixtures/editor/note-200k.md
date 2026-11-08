# 200 KB 性能样本：向量检索与倒排索引

> 这份文件由脚本生成，只用于编辑器性能基线；内容不含真实业务数据。

## 第 1 节 · 混合检索与倒数排名融合

稠密向量检索擅长语义近似，但对专有名词与代码标识符的召回不稳定；稀疏检索（BM25）恰好互补。

倒数排名融合（RRF）以 1/(k+rank) 对各路结果加权求和，无需分数归一化，k 取 60 时在多数基准上表现稳健。

评测采用 nDCG@10 与 MRR 两个指标，黄金集为 20 条人工标注的单点定位题；重排阶段再以交叉编码器对前 20 条精排。

守护进程与 CLI 通过 Unix 域套接字通信；断线后 CLI 自动降级为直读 SQLite，恢复后重新接入队列。

所有解析与排版都在 Worker 中完成，主线程只处理输入、DOM overlay 与工具栏；没有跨线程的大对象拷贝。

- 稠密 + 稀疏互补
- RRF 不需要归一化
- 重排只处理前 20 条

| 指标 | 20 | 60 | 100 |
|---|---|---|---|
| nDCG | 0.412 | 0.438 | 0.431 |
| MRR | 0.381 | 0.402 | 0.399 |

```rust
fn score_1(rank: usize, k: f64) -> f64 {
    1.0 / (k + rank as f64)
}
```

## 第 2 节 · 混合检索与倒数排名融合

稠密向量检索擅长语义近似，但对专有名词与代码标识符的召回不稳定；稀疏检索（BM25）恰好互补。

倒数排名融合（RRF）以 1/(k+rank) 对各路结果加权求和，无需分数归一化，k 取 60 时在多数基准上表现稳健。

评测采用 nDCG@10 与 MRR 两个指标，黄金集为 20 条人工标注的单点定位题；重排阶段再以交叉编码器对前 20 条精排。

守护进程与 CLI 通过 Unix 域套接字通信；断线后 CLI 自动降级为直读 SQLite，恢复后重新接入队列。

所有解析与排版都在 Worker 中完成，主线程只处理输入、DOM overlay 与工具栏；没有跨线程的大对象拷贝。

- 稠密 + 稀疏互补
- RRF 不需要归一化
- 重排只处理前 20 条

| 指标 | 20 | 60 | 100 |
|---|---|---|---|
| nDCG | 0.412 | 0.438 | 0.431 |
| MRR | 0.381 | 0.402 | 0.399 |

```rust
fn score_2(rank: usize, k: f64) -> f64 {
    1.0 / (k + rank as f64)
}
```

## 第 3 节 · 混合检索与倒数排名融合

稠密向量检索擅长语义近似，但对专有名词与代码标识符的召回不稳定；稀疏检索（BM25）恰好互补。

倒数排名融合（RRF）以 1/(k+rank) 对各路结果加权求和，无需分数归一化，k 取 60 时在多数基准上表现稳健。

评测采用 nDCG@10 与 MRR 两个指标，黄金集为 20 条人工标注的单点定位题；重排阶段再以交叉编码器对前 20 条精排。

守护进程与 CLI 通过 Unix 域套接字通信；断线后 CLI 自动降级为直读 SQLite，恢复后重新接入队列。

所有解析与排版都在 Worker 中完成，主线程只处理输入、DOM overlay 与工具栏；没有跨线程的大对象拷贝。

- 稠密 + 稀疏互补
- RRF 不需要归一化
- 重排只处理前 20 条

| 指标 | 20 | 60 | 100 |
|---|---|---|---|
| nDCG | 0.412 | 0.438 | 0.431 |
| MRR | 0.381 | 0.402 | 0.399 |

```rust
fn score_3(rank: usize, k: f64) -> f64 {
    1.0 / (k + rank as f64)
}
```

## 第 4 节 · 混合检索与倒数排名融合

稠密向量检索擅长语义近似，但对专有名词与代码标识符的召回不稳定；稀疏检索（BM25）恰好互补。

倒数排名融合（RRF）以 1/(k+rank) 对各路结果加权求和，无需分数归一化，k 取 60 时在多数基准上表现稳健。

评测采用 nDCG@10 与 MRR 两个指标，黄金集为 20 条人工标注的单点定位题；重排阶段再以交叉编码器对前 20 条精排。

守护进程与 CLI 通过 Unix 域套接字通信；断线后 CLI 自动降级为直读 SQLite，恢复后重新接入队列。

所有解析与排版都在 Worker 中完成，主线程只处理输入、DOM overlay 与工具栏；没有跨线程的大对象拷贝。

- 稠密 + 稀疏互补
- RRF 不需要归一化
- 重排只处理前 20 条

| 指标 | 20 | 60 | 100 |
|---|---|---|---|
| nDCG | 0.412 | 0.438 | 0.431 |
| MRR | 0.381 | 0.402 | 0.399 |

```rust
fn score_4(rank: usize, k: f64) -> f64 {
    1.0 / (k + rank as f64)
}
```

## 第 5 节 · 混合检索与倒数排名融合

稠密向量检索擅长语义近似，但对专有名词与代码标识符的召回不稳定；稀疏检索（BM25）恰好互补。

倒数排名融合（RRF）以 1/(k+rank) 对各路结果加权求和，无需分数归一化，k 取 60 时在多数基准上表现稳健。

评测采用 nDCG@10 与 MRR 两个指标，黄金集为 20 条人工标注的单点定位题；重排阶段再以交叉编码器对前 20 条精排。

守护进程与 CLI 通过 Unix 域套接字通信；断线后 CLI 自动降级为直读 SQLite，恢复后重新接入队列。

所有解析与排版都在 Worker 中完成，主线程只处理输入、DOM overlay 与工具栏；没有跨线程的大对象拷贝。

- 稠密 + 稀疏互补
- RRF 不需要归一化
- 重排只处理前 20 条

| 指标 | 20 | 60 | 100 |
|---|---|---|---|
| nDCG | 0.412 | 0.438 | 0.431 |
| MRR | 0.381 | 0.402 | 0.399 |

```rust
fn score_5(rank: usize, k: f64) -> f64 {
    1.0 / (k + rank as f64)
}
```

## 第 6 节 · 混合检索与倒数排名融合

稠密向量检索擅长语义近似，但对专有名词与代码标识符的召回不稳定；稀疏检索（BM25）恰好互补。

倒数排名融合（RRF）以 1/(k+rank) 对各路结果加权求和，无需分数归一化，k 取 60 时在多数基准上表现稳健。

评测采用 nDCG@10 与 MRR 两个指标，黄金集为 20 条人工标注的单点定位题；重排阶段再以交叉编码器对前 20 条精排。

守护进程与 CLI 通过 Unix 域套接字通信；断线后 CLI 自动降级为直读 SQLite，恢复后重新接入队列。

所有解析与排版都在 Worker 中完成，主线程只处理输入、DOM overlay 与工具栏；没有跨线程的大对象拷贝。

- 稠密 + 稀疏互补
- RRF 不需要归一化
- 重排只处理前 20 条

| 指标 | 20 | 60 | 100 |
|---|---|---|---|
| nDCG | 0.412 | 0.438 | 0.431 |
| MRR | 0.381 | 0.402 | 0.399 |

```rust
fn score_6(rank: usize, k: f64) -> f64 {
    1.0 / (k + rank as f64)
}
```

## 第 7 节 · 混合检索与倒数排名融合

稠密向量检索擅长语义近似，但对专有名词与代码标识符的召回不稳定；稀疏检索（BM25）恰好互补。

倒数排名融合（RRF）以 1/(k+rank) 对各路结果加权求和，无需分数归一化，k 取 60 时在多数基准上表现稳健。

评测采用 nDCG@10 与 MRR 两个指标，黄金集为 20 条人工标注的单点定位题；重排阶段再以交叉编码器对前 20 条精排。

守护进程与 CLI 通过 Unix 域套接字通信；断线后 CLI 自动降级为直读 SQLite，恢复后重新接入队列。

所有解析与排版都在 Worker 中完成，主线程只处理输入、DOM overlay 与工具栏；没有跨线程的大对象拷贝。

- 稠密 + 稀疏互补
- RRF 不需要归一化
- 重排只处理前 20 条

| 指标 | 20 | 60 | 100 |
|---|---|---|---|
| nDCG | 0.412 | 0.438 | 0.431 |
| MRR | 0.381 | 0.402 | 0.399 |

```rust
fn score_7(rank: usize, k: f64) -> f64 {
    1.0 / (k + rank as f64)
}
```

## 第 8 节 · 混合检索与倒数排名融合

稠密向量检索擅长语义近似，但对专有名词与代码标识符的召回不稳定；稀疏检索（BM25）恰好互补。

倒数排名融合（RRF）以 1/(k+rank) 对各路结果加权求和，无需分数归一化，k 取 60 时在多数基准上表现稳健。

评测采用 nDCG@10 与 MRR 两个指标，黄金集为 20 条人工标注的单点定位题；重排阶段再以交叉编码器对前 20 条精排。

守护进程与 CLI 通过 Unix 域套接字通信；断线后 CLI 自动降级为直读 SQLite，恢复后重新接入队列。

所有解析与排版都在 Worker 中完成，主线程只处理输入、DOM overlay 与工具栏；没有跨线程的大对象拷贝。

- 稠密 + 稀疏互补
- RRF 不需要归一化
- 重排只处理前 20 条

| 指标 | 20 | 60 | 100 |
|---|---|---|---|
| nDCG | 0.412 | 0.438 | 0.431 |
| MRR | 0.381 | 0.402 | 0.399 |

```rust
fn score_8(rank: usize, k: f64) -> f64 {
    1.0 / (k + rank as f64)
}
```

## 第 9 节 · 混合检索与倒数排名融合

稠密向量检索擅长语义近似，但对专有名词与代码标识符的召回不稳定；稀疏检索（BM25）恰好互补。

倒数排名融合（RRF）以 1/(k+rank) 对各路结果加权求和，无需分数归一化，k 取 60 时在多数基准上表现稳健。

评测采用 nDCG@10 与 MRR 两个指标，黄金集为 20 条人工标注的单点定位题；重排阶段再以交叉编码器对前 20 条精排。

守护进程与 CLI 通过 Unix 域套接字通信；断线后 CLI 自动降级为直读 SQLite，恢复后重新接入队列。

所有解析与排版都在 Worker 中完成，主线程只处理输入、DOM overlay 与工具栏；没有跨线程的大对象拷贝。

- 稠密 + 稀疏互补
- RRF 不需要归一化
- 重排只处理前 20 条

| 指标 | 20 | 60 | 100 |
|---|---|---|---|
| nDCG | 0.412 | 0.438 | 0.431 |
| MRR | 0.381 | 0.402 | 0.399 |

```rust
fn score_9(rank: usize, k: f64) -> f64 {
    1.0 / (k + rank as f64)
}
```

## 第 10 节 · 混合检索与倒数排名融合

稠密向量检索擅长语义近似，但对专有名词与代码标识符的召回不稳定；稀疏检索（BM25）恰好互补。

倒数排名融合（RRF）以 1/(k+rank) 对各路结果加权求和，无需分数归一化，k 取 60 时在多数基准上表现稳健。

评测采用 nDCG@10 与 MRR 两个指标，黄金集为 20 条人工标注的单点定位题；重排阶段再以交叉编码器对前 20 条精排。

守护进程与 CLI 通过 Unix 域套接字通信；断线后 CLI 自动降级为直读 SQLite，恢复后重新接入队列。

所有解析与排版都在 Worker 中完成，主线程只处理输入、DOM overlay 与工具栏；没有跨线程的大对象拷贝。

- 稠密 + 稀疏互补
- RRF 不需要归一化
- 重排只处理前 20 条

| 指标 | 20 | 60 | 100 |
|---|---|---|---|
| nDCG | 0.412 | 0.438 | 0.431 |
| MRR | 0.381 | 0.402 | 0.399 |

```rust
fn score_10(rank: usize, k: f64) -> f64 {
    1.0 / (k + rank as f64)
}
```

![基准图 10](data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAA8AAAAIcCAIAAAC2P1AsAAASoElEQVR4nO3ce5Tf853H8c/8MpOc7cY1LHbrEhL3S0upu4rIBquEIFmJiBypRkgoYRSpFINVm7qt0lEEpW6pXVbXNa7FaXdru/QYqhrqtCSSkoQZmdk/fj3ZnJnJNC+1fobH46/ffM5nvt/3b37/PPM531/q5i9cUgAAgJVTqfUAAADQmwhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAjU1+rGW2y3e61uDQDAp8MLv3j847+pE2gAAAgIaAAACNTsEY5lanLwDgBA71Xbh4GdQAMAQEBAAwBAQEADAEBAQAMAQEBAAwBAQEADAEBAQAMAQEBAAwBAQEADAEBAQAMAQEBAAwBAQEADAEBAQAMAQEBAAwBAQEADAEBAQAMAQEBAAwBAQEADAEBAQAMAQEBAAwBAQEADAEBAQAMAQEBAAwBAQEADAEBAQAMAQEBAAwBAQEADAEBAQAMAQKC+1gN8SF/caZ9tttmio6MsWrS48dQTd/zSF1a0Ut0/5Cu7Hz121Mpc+Zprbzz2mDHLr7z08ivP/uy/Rh8+4kPMudNuw5954r4V/fihfVTX6eFSd8y+567Z9yxavPiUkybttstO77z7buOZ57399oI11li96dxvrtK/f9c9Tz717PRvX7TeeuuUUnb44nZTJh/7kUwIAPCJ0lsDuqGh4Ybmy0spL7a8fGrjjB/ffn0PK5FrmjsH9KBNBg7aZOBHNXmvMP/tBbPv/vcbrr38N6/OPeGkM+6ZfdP3rrnhSztsd/TYUT+44Zarm2d9Y8rXu+55a978CeOPHHXYwbUeHwDg/1Gvf4Rj8KCNf/+HN3te6WSn3Yafcfb5s26+7Y9/fGfaGTPGT5wyZvzxz/3y+VLKZVc2L168eMJxJy2/rfq6lNJ1/4jDj67eq7W1bfiBo15sefnIcV8/8JCx18+6dUV3/6dLrhhz9KQx449/7fU3ul6weq+Zl1099pjJBx827oGHHi2lvL1g4QknnXHUhMkTjjtp3vy3q9uqe7566FHVPdVf/Ob0pmEHHH7LbbOnnTFj3/0Pq47x0suvdJpq+bdWNW/+2weNHPfSy69Uf1ywYOGRow6tVCrrrbvOggULSylzHntq/+FDSyn7D99nzqNPdbvnzTffWnutAX/+MwMA6M166wn0Mk889czOO+3Q80onrW2t+w/fZ/ddv3zmty4YM3rkttts+cYbv5805bS7fnTdCZMmzLrptuar/nn5bct+8aJLrui0f9jQvR965PHRh494+tmf77Hbzj+89a6Tpxw3aJOBBx4ydtzYI7q99dZbbX7qycfffc9PLrj40tVXW63TBUspbW1ta6y+2qxrL5/72u+OmjB56JA9L7z4suHDhhyw39A7Z99z+ZXN0888pbWttbrnN6/OHT9xytAhe5ZS3m99/4iRB00+7ph99ht5y43fm3rCxFFjvjZu7BE3/fCOTlN1emttbW3fmDa9cdqJyw7aNx644cYDNyyl/OT+h/fea7dSyrx589casGYpZe21BsybN7/bPX94a96rc1+/9rqbV1tt1dNPPXGD9f/uQ32kAACfaL01oNva2o6aMPmDD5b++pVX/+3OG3tYqe4/56xpAzfaoPq6UqnsuvOOpZQnnnzmt3Nfqy4uXvLe0vb2PpX/O5Jftm2ZrvuHD9v7/Au/O/rwEQ/PefyA/fbdfNNB9973wMOPPvnuokXdjl1X6qqxO3zfIRd954qG+vquA7R3tB9y8AGllPU//7fvvrOolPLTp3/27emnlVIO+up++w7dq5TS0dFR3bPRhutX95RSKnWVrbbavE+l0tBQv/WWm1cqlffee7+UcspJkzpN1emtzTj/kgMPGNb1Xx2/nft683U3X998WQ8fxPJ76urqNt900Iyzp93/4Jyzz7nwuu9f2sMvAgD0Ur01oJc939z8g5vuuvveY48Z08NKJ/V96iuVSinlg6UfXHPlJf369W1vb//5fz63fD0vv22ZrvsHbrTBgoUL31206IVftZzVePLESacMG7rXmNGH3vKju7odu65SV+nTp/q6b9+Gtra2rgM0NDSsskr/P+2vqyulLG1f2tFRSil9KpXqt/e67qkuVq/Qr2+/5SefespZnaZa/q21trW2vPTrUsqhI/5h+VEXL15y8rSzzzuncc01Vi+lDBiw5lvz5v/N2mu9+da8AQPW7HbP2H8cue6665RShuy9x/QZF3X7FwAA6O16/TPQu+6y43P//XzPKyuy/Re2rT5A/NgTP726eVZ1sb2jvb29feX3D/nKHtc037jt1lvU1dX98vlfDf/7Ia3vt7a2tnV7haVLlz762FOllPvuf+jLO27f7QUrdZ0/lG233vLBRx4rpdx+579e8t2rut3Tg56n6tvQ9+br/+X1371x2x13L1vs6Og4/cxzxx81ettttqyu7LXHLvfe90Ap5d77Htxzj1263fOdmVc9MueJUspzz/3PpoM3WfkJAQB6kd56Ar3MwI02eLHl5eWTt+vKijSeeuLZMy685bbZ9X36zJh+WnVxh+23m3Ti6Vdd3s0Barf7hw/b+6CR467//qWllNGHjxg99rjNNxu06ir9W1vb+vZt2HDDz1/dPGvihLHVzf369vuPBx5pvu7mVVfpf+45ja3vt3a9YFennXLCmd9quvmWO1fp/9cXnnfWSv9t/qTrVJ02VCqViy/41qgxEzfbbNC2W29ZSrnrx/c+/uTTCxYuvPX22Z/7q89ddflFXzv2qMYzz7v/gTnV/8au2z1TJh97xlnnXX/jrf369uvh7QAA9Gp18xcuqcmNt9hu9+qLF37xeE0GAACgl6ptSfb6RzgAAODjJKABACAgoAEAICCgAQAgIKABACAgoAEAICCgAQAgIKABACAgoAEAICCgAQAgIKABACAgoAEAICCgAQAgIKABACAgoAEAICCgAQAgIKABACAgoAEAICCgAQAgIKABACAgoAEAICCgAQAgIKABACAgoAEAICCgAQAgIKABACAgoAEAICCgAQAgIKABACAgoAEAICCgAQAgIKABACAgoAEAICCgAQAgIKABACAgoAEAICCgAQAgIKABACAgoAEAICCgAQAgIKABACAgoAEAICCgAQAgIKABACAgoAEAICCgAQAgIKABACAgoAEAICCgAQAgIKABACAgoAEAICCgAQAgIKABACAgoAEAICCgAQAgIKABACAgoAEAICCgAQAgIKABACAgoAEAICCgAQAgIKABACAgoAEAICCgAQAgIKABACAgoAEAICCgAQAgUF/rAcoW2+1e6xEAAGBlOYEGAICAgAYAgEDd/IVLaj0DAAD0Gk6gAQAgIKABACAgoAEAICCgAQAgIKABACAgoAEAICCgAQAgIKABACAgoAEAICCgAQAgIKABACAgoAEAIFBf6wEA4NNsamNLbQeY2TS4tgPAp48TaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAjU13oAAD7rpja21HaAmU2DazsA0Ls4gQYAgICABgCAgIAGAICAgAYAgICABgCAgIAGAICAgAYAgICABgCAgIAGAICAgAYAgICABgCAgIAGAICAgAYAgICABgCAgIAGAICAgAYAgICABgCAgIAGAICAgAYAgICABgCAgIAGAICAgAYAgICABgCAgIAGAICAgAYAgICABgCAgIAGAICAgAYAgICABgCAgIAGAICAgAYAgICABgCAgIAGAICAgAYAgICABgCAgIAGAIBAfa0HAODPm9rYUtsBZjYNru0AAJ8cTqABACAgoAEAICCgAQAgIKABACAgoAEAICCgAQAgIKABACAgoAEAICCgAQAgIKABACAgoAEAICCgAQAgIKABACAgoAEAICCgAQAgIKABACAgoAEAICCgAQAgIKABACAgoAEAICCgAQAgIKABACAgoAEAICCgAQAgIKABACAgoAEAICCgAQAgIKABACAgoAEAICCgAQAgIKABACAgoAEAICCgAQAgIKABACAgoAEAICCgAQAgUF/rAQA+GlMbW2o7wMymwbUdAICPhxNoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACNTXegDg4zO1saW2A8xsGlzbAQDgL+cEGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAL1tR4APlmmNrbUdoCZTYNrOwAA0DMn0AAAEBDQAAAQENAAABDwDDQAwGeO7/z8JZxAAwBAQEADAEBAQAMAQEBAAwBAQEADAEBAQAMAQEBAAwBAQEADAEBAQAMAQEBAAwBAQEADAEBAQAMAQEBAAwBAQEADAEBAQAMAQEBAAwBAQEADAEBAQAMAQEBAAwBAQEADAEBAQAMAQEBAAwBAQEADAEBAQAMAQEBAAwBAQEADAEBAQAMAQEBAAwBAQEADAEBAQAMAQEBAAwBAQEADAECgvtYD0PtMbWyp7QAzmwbXdgAA4LPMCTQAAAQENAAABAQ0AAAEPAMNANAN3/lhRZxAAwBAQEADAEBAQAMAQEBAAwBAQEADAEBAQAMAQEBAAwBAQEADAEBAQAMAQEBAAwBAQEADAEBAQAMAQEBAAwBAQEADAEBAQAMAQEBAAwBAQEADAEBAQAMAQEBAAwBAQEADAEBAQAMAQEBAAwBAQEADAEBAQAMAQEBAAwBAQEADAEBAQAMAQEBAAwBAQEADAEBAQAMAQEBAAwBAQEADAECgvtYDfDpNbWyp7QAzmwbXdgAAgE8rJ9AAABAQ0AAAEBDQAAAQ8Aw0APAh+c4Pn01OoAEAICCgAQAgIKABACAgoAEAICCgAQAgIKABACAgoAEAICCgAQAgIKABACAgoAEAICCgAQAgIKABACAgoAEAICCgAQAgIKABACAgoAEAICCgAQAgIKABACAgoAEAICCgAQAgIKABACAgoAEAICCgAQAgIKABACAgoAEAICCgAQAgIKABACAgoAEAICCgAQAgIKABACAgoAEAICCgAQAgUF+rG09tbKnVratmNg2u7QAAAPRGdfMXLqn1DAAA0Gt4hAMAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAAC/wuzN58Z+uwyoQAAAABJRU5ErkJggg==)

## 第 11 节 · 混合检索与倒数排名融合

稠密向量检索擅长语义近似，但对专有名词与代码标识符的召回不稳定；稀疏检索（BM25）恰好互补。

倒数排名融合（RRF）以 1/(k+rank) 对各路结果加权求和，无需分数归一化，k 取 60 时在多数基准上表现稳健。

评测采用 nDCG@10 与 MRR 两个指标，黄金集为 20 条人工标注的单点定位题；重排阶段再以交叉编码器对前 20 条精排。

守护进程与 CLI 通过 Unix 域套接字通信；断线后 CLI 自动降级为直读 SQLite，恢复后重新接入队列。

所有解析与排版都在 Worker 中完成，主线程只处理输入、DOM overlay 与工具栏；没有跨线程的大对象拷贝。

- 稠密 + 稀疏互补
- RRF 不需要归一化
- 重排只处理前 20 条

| 指标 | 20 | 60 | 100 |
|---|---|---|---|
| nDCG | 0.412 | 0.438 | 0.431 |
| MRR | 0.381 | 0.402 | 0.399 |

```rust
fn score_11(rank: usize, k: f64) -> f64 {
    1.0 / (k + rank as f64)
}
```

## 第 12 节 · 混合检索与倒数排名融合

稠密向量检索擅长语义近似，但对专有名词与代码标识符的召回不稳定；稀疏检索（BM25）恰好互补。

倒数排名融合（RRF）以 1/(k+rank) 对各路结果加权求和，无需分数归一化，k 取 60 时在多数基准上表现稳健。

评测采用 nDCG@10 与 MRR 两个指标，黄金集为 20 条人工标注的单点定位题；重排阶段再以交叉编码器对前 20 条精排。

守护进程与 CLI 通过 Unix 域套接字通信；断线后 CLI 自动降级为直读 SQLite，恢复后重新接入队列。

所有解析与排版都在 Worker 中完成，主线程只处理输入、DOM overlay 与工具栏；没有跨线程的大对象拷贝。

- 稠密 + 稀疏互补
- RRF 不需要归一化
- 重排只处理前 20 条

| 指标 | 20 | 60 | 100 |
|---|---|---|---|
| nDCG | 0.412 | 0.438 | 0.431 |
| MRR | 0.381 | 0.402 | 0.399 |

```rust
fn score_12(rank: usize, k: f64) -> f64 {
    1.0 / (k + rank as f64)
}
```

## 第 13 节 · 混合检索与倒数排名融合

稠密向量检索擅长语义近似，但对专有名词与代码标识符的召回不稳定；稀疏检索（BM25）恰好互补。

倒数排名融合（RRF）以 1/(k+rank) 对各路结果加权求和，无需分数归一化，k 取 60 时在多数基准上表现稳健。

评测采用 nDCG@10 与 MRR 两个指标，黄金集为 20 条人工标注的单点定位题；重排阶段再以交叉编码器对前 20 条精排。

守护进程与 CLI 通过 Unix 域套接字通信；断线后 CLI 自动降级为直读 SQLite，恢复后重新接入队列。

所有解析与排版都在 Worker 中完成，主线程只处理输入、DOM overlay 与工具栏；没有跨线程的大对象拷贝。

- 稠密 + 稀疏互补
- RRF 不需要归一化
- 重排只处理前 20 条

| 指标 | 20 | 60 | 100 |
|---|---|---|---|
| nDCG | 0.412 | 0.438 | 0.431 |
| MRR | 0.381 | 0.402 | 0.399 |

```rust
fn score_13(rank: usize, k: f64) -> f64 {
    1.0 / (k + rank as f64)
}
```

## 第 14 节 · 混合检索与倒数排名融合

稠密向量检索擅长语义近似，但对专有名词与代码标识符的召回不稳定；稀疏检索（BM25）恰好互补。

倒数排名融合（RRF）以 1/(k+rank) 对各路结果加权求和，无需分数归一化，k 取 60 时在多数基准上表现稳健。

评测采用 nDCG@10 与 MRR 两个指标，黄金集为 20 条人工标注的单点定位题；重排阶段再以交叉编码器对前 20 条精排。

守护进程与 CLI 通过 Unix 域套接字通信；断线后 CLI 自动降级为直读 SQLite，恢复后重新接入队列。

所有解析与排版都在 Worker 中完成，主线程只处理输入、DOM overlay 与工具栏；没有跨线程的大对象拷贝。

- 稠密 + 稀疏互补
- RRF 不需要归一化
- 重排只处理前 20 条

| 指标 | 20 | 60 | 100 |
|---|---|---|---|
| nDCG | 0.412 | 0.438 | 0.431 |
| MRR | 0.381 | 0.402 | 0.399 |

```rust
fn score_14(rank: usize, k: f64) -> f64 {
    1.0 / (k + rank as f64)
}
```

## 第 15 节 · 混合检索与倒数排名融合

稠密向量检索擅长语义近似，但对专有名词与代码标识符的召回不稳定；稀疏检索（BM25）恰好互补。

倒数排名融合（RRF）以 1/(k+rank) 对各路结果加权求和，无需分数归一化，k 取 60 时在多数基准上表现稳健。

评测采用 nDCG@10 与 MRR 两个指标，黄金集为 20 条人工标注的单点定位题；重排阶段再以交叉编码器对前 20 条精排。

守护进程与 CLI 通过 Unix 域套接字通信；断线后 CLI 自动降级为直读 SQLite，恢复后重新接入队列。

所有解析与排版都在 Worker 中完成，主线程只处理输入、DOM overlay 与工具栏；没有跨线程的大对象拷贝。

- 稠密 + 稀疏互补
- RRF 不需要归一化
- 重排只处理前 20 条

| 指标 | 20 | 60 | 100 |
|---|---|---|---|
| nDCG | 0.412 | 0.438 | 0.431 |
| MRR | 0.381 | 0.402 | 0.399 |

```rust
fn score_15(rank: usize, k: f64) -> f64 {
    1.0 / (k + rank as f64)
}
```

## 第 16 节 · 混合检索与倒数排名融合

稠密向量检索擅长语义近似，但对专有名词与代码标识符的召回不稳定；稀疏检索（BM25）恰好互补。

倒数排名融合（RRF）以 1/(k+rank) 对各路结果加权求和，无需分数归一化，k 取 60 时在多数基准上表现稳健。

评测采用 nDCG@10 与 MRR 两个指标，黄金集为 20 条人工标注的单点定位题；重排阶段再以交叉编码器对前 20 条精排。

守护进程与 CLI 通过 Unix 域套接字通信；断线后 CLI 自动降级为直读 SQLite，恢复后重新接入队列。

所有解析与排版都在 Worker 中完成，主线程只处理输入、DOM overlay 与工具栏；没有跨线程的大对象拷贝。

- 稠密 + 稀疏互补
- RRF 不需要归一化
- 重排只处理前 20 条

| 指标 | 20 | 60 | 100 |
|---|---|---|---|
| nDCG | 0.412 | 0.438 | 0.431 |
| MRR | 0.381 | 0.402 | 0.399 |

```rust
fn score_16(rank: usize, k: f64) -> f64 {
    1.0 / (k + rank as f64)
}
```

## 第 17 节 · 混合检索与倒数排名融合

稠密向量检索擅长语义近似，但对专有名词与代码标识符的召回不稳定；稀疏检索（BM25）恰好互补。

倒数排名融合（RRF）以 1/(k+rank) 对各路结果加权求和，无需分数归一化，k 取 60 时在多数基准上表现稳健。

评测采用 nDCG@10 与 MRR 两个指标，黄金集为 20 条人工标注的单点定位题；重排阶段再以交叉编码器对前 20 条精排。

守护进程与 CLI 通过 Unix 域套接字通信；断线后 CLI 自动降级为直读 SQLite，恢复后重新接入队列。

所有解析与排版都在 Worker 中完成，主线程只处理输入、DOM overlay 与工具栏；没有跨线程的大对象拷贝。

- 稠密 + 稀疏互补
- RRF 不需要归一化
- 重排只处理前 20 条

| 指标 | 20 | 60 | 100 |
|---|---|---|---|
| nDCG | 0.412 | 0.438 | 0.431 |
| MRR | 0.381 | 0.402 | 0.399 |

```rust
fn score_17(rank: usize, k: f64) -> f64 {
    1.0 / (k + rank as f64)
}
```

## 第 18 节 · 混合检索与倒数排名融合

稠密向量检索擅长语义近似，但对专有名词与代码标识符的召回不稳定；稀疏检索（BM25）恰好互补。

倒数排名融合（RRF）以 1/(k+rank) 对各路结果加权求和，无需分数归一化，k 取 60 时在多数基准上表现稳健。

评测采用 nDCG@10 与 MRR 两个指标，黄金集为 20 条人工标注的单点定位题；重排阶段再以交叉编码器对前 20 条精排。

守护进程与 CLI 通过 Unix 域套接字通信；断线后 CLI 自动降级为直读 SQLite，恢复后重新接入队列。

所有解析与排版都在 Worker 中完成，主线程只处理输入、DOM overlay 与工具栏；没有跨线程的大对象拷贝。

- 稠密 + 稀疏互补
- RRF 不需要归一化
- 重排只处理前 20 条

| 指标 | 20 | 60 | 100 |
|---|---|---|---|
| nDCG | 0.412 | 0.438 | 0.431 |
| MRR | 0.381 | 0.402 | 0.399 |

```rust
fn score_18(rank: usize, k: f64) -> f64 {
    1.0 / (k + rank as f64)
}
```

## 第 19 节 · 混合检索与倒数排名融合

稠密向量检索擅长语义近似，但对专有名词与代码标识符的召回不稳定；稀疏检索（BM25）恰好互补。

倒数排名融合（RRF）以 1/(k+rank) 对各路结果加权求和，无需分数归一化，k 取 60 时在多数基准上表现稳健。

评测采用 nDCG@10 与 MRR 两个指标，黄金集为 20 条人工标注的单点定位题；重排阶段再以交叉编码器对前 20 条精排。

守护进程与 CLI 通过 Unix 域套接字通信；断线后 CLI 自动降级为直读 SQLite，恢复后重新接入队列。

所有解析与排版都在 Worker 中完成，主线程只处理输入、DOM overlay 与工具栏；没有跨线程的大对象拷贝。

- 稠密 + 稀疏互补
- RRF 不需要归一化
- 重排只处理前 20 条

| 指标 | 20 | 60 | 100 |
|---|---|---|---|
| nDCG | 0.412 | 0.438 | 0.431 |
| MRR | 0.381 | 0.402 | 0.399 |

```rust
fn score_19(rank: usize, k: f64) -> f64 {
    1.0 / (k + rank as f64)
}
```

## 第 20 节 · 混合检索与倒数排名融合

稠密向量检索擅长语义近似，但对专有名词与代码标识符的召回不稳定；稀疏检索（BM25）恰好互补。

倒数排名融合（RRF）以 1/(k+rank) 对各路结果加权求和，无需分数归一化，k 取 60 时在多数基准上表现稳健。

评测采用 nDCG@10 与 MRR 两个指标，黄金集为 20 条人工标注的单点定位题；重排阶段再以交叉编码器对前 20 条精排。

守护进程与 CLI 通过 Unix 域套接字通信；断线后 CLI 自动降级为直读 SQLite，恢复后重新接入队列。

所有解析与排版都在 Worker 中完成，主线程只处理输入、DOM overlay 与工具栏；没有跨线程的大对象拷贝。

- 稠密 + 稀疏互补
- RRF 不需要归一化
- 重排只处理前 20 条

| 指标 | 20 | 60 | 100 |
|---|---|---|---|
| nDCG | 0.412 | 0.438 | 0.431 |
| MRR | 0.381 | 0.402 | 0.399 |

```rust
fn score_20(rank: usize, k: f64) -> f64 {
    1.0 / (k + rank as f64)
}
```

![基准图 20](data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAA8AAAAIcCAIAAAC2P1AsAAASoElEQVR4nO3ce5Tf853H8c/8MpOc7cY1LHbrEhL3S0upu4rIBquEIFmJiBypRkgoYRSpFINVm7qt0lEEpW6pXVbXNa7FaXdru/QYqhrqtCSSkoQZmdk/fj3ZnJnJNC+1fobH46/ffM5nvt/3b37/PPM531/q5i9cUgAAgJVTqfUAAADQmwhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAjU1+rGW2y3e61uDQDAp8MLv3j847+pE2gAAAgIaAAACNTsEY5lanLwDgBA71Xbh4GdQAMAQEBAAwBAQEADAEBAQAMAQEBAAwBAQEADAEBAQAMAQEBAAwBAQEADAEBAQAMAQEBAAwBAQEADAEBAQAMAQEBAAwBAQEADAEBAQAMAQEBAAwBAQEADAEBAQAMAQEBAAwBAQEADAEBAQAMAQEBAAwBAQEADAEBAQAMAQEBAAwBAQEADAEBAQAMAQKC+1gN8SF/caZ9tttmio6MsWrS48dQTd/zSF1a0Ut0/5Cu7Hz121Mpc+Zprbzz2mDHLr7z08ivP/uy/Rh8+4kPMudNuw5954r4V/fihfVTX6eFSd8y+567Z9yxavPiUkybttstO77z7buOZ57399oI11li96dxvrtK/f9c9Tz717PRvX7TeeuuUUnb44nZTJh/7kUwIAPCJ0lsDuqGh4Ybmy0spL7a8fGrjjB/ffn0PK5FrmjsH9KBNBg7aZOBHNXmvMP/tBbPv/vcbrr38N6/OPeGkM+6ZfdP3rrnhSztsd/TYUT+44Zarm2d9Y8rXu+55a978CeOPHHXYwbUeHwDg/1Gvf4Rj8KCNf/+HN3te6WSn3Yafcfb5s26+7Y9/fGfaGTPGT5wyZvzxz/3y+VLKZVc2L168eMJxJy2/rfq6lNJ1/4jDj67eq7W1bfiBo15sefnIcV8/8JCx18+6dUV3/6dLrhhz9KQx449/7fU3ul6weq+Zl1099pjJBx827oGHHi2lvL1g4QknnXHUhMkTjjtp3vy3q9uqe7566FHVPdVf/Ob0pmEHHH7LbbOnnTFj3/0Pq47x0suvdJpq+bdWNW/+2weNHPfSy69Uf1ywYOGRow6tVCrrrbvOggULSylzHntq/+FDSyn7D99nzqNPdbvnzTffWnutAX/+MwMA6M166wn0Mk889czOO+3Q80onrW2t+w/fZ/ddv3zmty4YM3rkttts+cYbv5805bS7fnTdCZMmzLrptuar/nn5bct+8aJLrui0f9jQvR965PHRh494+tmf77Hbzj+89a6Tpxw3aJOBBx4ydtzYI7q99dZbbX7qycfffc9PLrj40tVXW63TBUspbW1ta6y+2qxrL5/72u+OmjB56JA9L7z4suHDhhyw39A7Z99z+ZXN0888pbWttbrnN6/OHT9xytAhe5ZS3m99/4iRB00+7ph99ht5y43fm3rCxFFjvjZu7BE3/fCOTlN1emttbW3fmDa9cdqJyw7aNx644cYDNyyl/OT+h/fea7dSyrx589casGYpZe21BsybN7/bPX94a96rc1+/9rqbV1tt1dNPPXGD9f/uQ32kAACfaL01oNva2o6aMPmDD5b++pVX/+3OG3tYqe4/56xpAzfaoPq6UqnsuvOOpZQnnnzmt3Nfqy4uXvLe0vb2PpX/O5Jftm2ZrvuHD9v7/Au/O/rwEQ/PefyA/fbdfNNB9973wMOPPvnuokXdjl1X6qqxO3zfIRd954qG+vquA7R3tB9y8AGllPU//7fvvrOolPLTp3/27emnlVIO+up++w7dq5TS0dFR3bPRhutX95RSKnWVrbbavE+l0tBQv/WWm1cqlffee7+UcspJkzpN1emtzTj/kgMPGNb1Xx2/nft683U3X998WQ8fxPJ76urqNt900Iyzp93/4Jyzz7nwuu9f2sMvAgD0Ur01oJc939z8g5vuuvveY48Z08NKJ/V96iuVSinlg6UfXHPlJf369W1vb//5fz63fD0vv22ZrvsHbrTBgoUL31206IVftZzVePLESacMG7rXmNGH3vKju7odu65SV+nTp/q6b9+Gtra2rgM0NDSsskr/P+2vqyulLG1f2tFRSil9KpXqt/e67qkuVq/Qr2+/5SefespZnaZa/q21trW2vPTrUsqhI/5h+VEXL15y8rSzzzuncc01Vi+lDBiw5lvz5v/N2mu9+da8AQPW7HbP2H8cue6665RShuy9x/QZF3X7FwAA6O16/TPQu+6y43P//XzPKyuy/Re2rT5A/NgTP726eVZ1sb2jvb29feX3D/nKHtc037jt1lvU1dX98vlfDf/7Ia3vt7a2tnV7haVLlz762FOllPvuf+jLO27f7QUrdZ0/lG233vLBRx4rpdx+579e8t2rut3Tg56n6tvQ9+br/+X1371x2x13L1vs6Og4/cxzxx81ettttqyu7LXHLvfe90Ap5d77Htxzj1263fOdmVc9MueJUspzz/3PpoM3WfkJAQB6kd56Ar3MwI02eLHl5eWTt+vKijSeeuLZMy685bbZ9X36zJh+WnVxh+23m3Ti6Vdd3s0Barf7hw/b+6CR467//qWllNGHjxg99rjNNxu06ir9W1vb+vZt2HDDz1/dPGvihLHVzf369vuPBx5pvu7mVVfpf+45ja3vt3a9YFennXLCmd9quvmWO1fp/9cXnnfWSv9t/qTrVJ02VCqViy/41qgxEzfbbNC2W29ZSrnrx/c+/uTTCxYuvPX22Z/7q89ddflFXzv2qMYzz7v/gTnV/8au2z1TJh97xlnnXX/jrf369uvh7QAA9Gp18xcuqcmNt9hu9+qLF37xeE0GAACgl6ptSfb6RzgAAODjJKABACAgoAEAICCgAQAgIKABACAgoAEAICCgAQAgIKABACAgoAEAICCgAQAgIKABACAgoAEAICCgAQAgIKABACAgoAEAICCgAQAgIKABACAgoAEAICCgAQAgIKABACAgoAEAICCgAQAgIKABACAgoAEAICCgAQAgIKABACAgoAEAICCgAQAgIKABACAgoAEAICCgAQAgIKABACAgoAEAICCgAQAgIKABACAgoAEAICCgAQAgIKABACAgoAEAICCgAQAgIKABACAgoAEAICCgAQAgIKABACAgoAEAICCgAQAgIKABACAgoAEAICCgAQAgIKABACAgoAEAICCgAQAgIKABACAgoAEAICCgAQAgIKABACAgoAEAICCgAQAgIKABACAgoAEAICCgAQAgIKABACAgoAEAICCgAQAgIKABACAgoAEAICCgAQAgUF/rAcoW2+1e6xEAAGBlOYEGAICAgAYAgEDd/IVLaj0DAAD0Gk6gAQAgIKABACAgoAEAICCgAQAgIKABACAgoAEAICCgAQAgIKABACAgoAEAICCgAQAgIKABACAgoAEAIFBf6wEA4NNsamNLbQeY2TS4tgPAp48TaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAjU13oAAD7rpja21HaAmU2DazsA0Ls4gQYAgICABgCAgIAGAICAgAYAgICABgCAgIAGAICAgAYAgICABgCAgIAGAICAgAYAgICABgCAgIAGAICAgAYAgICABgCAgIAGAICAgAYAgICABgCAgIAGAICAgAYAgICABgCAgIAGAICAgAYAgICABgCAgIAGAICAgAYAgICABgCAgIAGAICAgAYAgICABgCAgIAGAICAgAYAgICABgCAgIAGAICAgAYAgICABgCAgIAGAIBAfa0HAODPm9rYUtsBZjYNru0AAJ8cTqABACAgoAEAICCgAQAgIKABACAgoAEAICCgAQAgIKABACAgoAEAICCgAQAgIKABACAgoAEAICCgAQAgIKABACAgoAEAICCgAQAgIKABACAgoAEAICCgAQAgIKABACAgoAEAICCgAQAgIKABACAgoAEAICCgAQAgIKABACAgoAEAICCgAQAgIKABACAgoAEAICCgAQAgIKABACAgoAEAICCgAQAgIKABACAgoAEAICCgAQAgUF/rAQA+GlMbW2o7wMymwbUdAICPhxNoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACNTXegDg4zO1saW2A8xsGlzbAQDgL+cEGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAL1tR4APlmmNrbUdoCZTYNrOwAA0DMn0AAAEBDQAAAQENAAABDwDDQAwGeO7/z8JZxAAwBAQEADAEBAQAMAQEBAAwBAQEADAEBAQAMAQEBAAwBAQEADAEBAQAMAQEBAAwBAQEADAEBAQAMAQEBAAwBAQEADAEBAQAMAQEBAAwBAQEADAEBAQAMAQEBAAwBAQEADAEBAQAMAQEBAAwBAQEADAEBAQAMAQEBAAwBAQEADAEBAQAMAQEBAAwBAQEADAEBAQAMAQEBAAwBAQEADAECgvtYD0PtMbWyp7QAzmwbXdgAA4LPMCTQAAAQENAAABAQ0AAAEPAMNANAN3/lhRZxAAwBAQEADAEBAQAMAQEBAAwBAQEADAEBAQAMAQEBAAwBAQEADAEBAQAMAQEBAAwBAQEADAEBAQAMAQEBAAwBAQEADAEBAQAMAQEBAAwBAQEADAEBAQAMAQEBAAwBAQEADAEBAQAMAQEBAAwBAQEADAEBAQAMAQEBAAwBAQEADAEBAQAMAQEBAAwBAQEADAEBAQAMAQEBAAwBAQEADAECgvtYDfDpNbWyp7QAzmwbXdgAAgE8rJ9AAABAQ0AAAEBDQAAAQ8Aw0APAh+c4Pn01OoAEAICCgAQAgIKABACAgoAEAICCgAQAgIKABACAgoAEAICCgAQAgIKABACAgoAEAICCgAQAgIKABACAgoAEAICCgAQAgIKABACAgoAEAICCgAQAgIKABACAgoAEAICCgAQAgIKABACAgoAEAICCgAQAgIKABACAgoAEAICCgAQAgIKABACAgoAEAICCgAQAgIKABACAgoAEAICCgAQAgUF+rG09tbKnVratmNg2u7QAAAPRGdfMXLqn1DAAA0Gt4hAMAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAAC/wuzN58Z+uwyoQAAAABJRU5ErkJggg==)

## 第 21 节 · 混合检索与倒数排名融合

稠密向量检索擅长语义近似，但对专有名词与代码标识符的召回不稳定；稀疏检索（BM25）恰好互补。

倒数排名融合（RRF）以 1/(k+rank) 对各路结果加权求和，无需分数归一化，k 取 60 时在多数基准上表现稳健。

评测采用 nDCG@10 与 MRR 两个指标，黄金集为 20 条人工标注的单点定位题；重排阶段再以交叉编码器对前 20 条精排。

守护进程与 CLI 通过 Unix 域套接字通信；断线后 CLI 自动降级为直读 SQLite，恢复后重新接入队列。

所有解析与排版都在 Worker 中完成，主线程只处理输入、DOM overlay 与工具栏；没有跨线程的大对象拷贝。

- 稠密 + 稀疏互补
- RRF 不需要归一化
- 重排只处理前 20 条

| 指标 | 20 | 60 | 100 |
|---|---|---|---|
| nDCG | 0.412 | 0.438 | 0.431 |
| MRR | 0.381 | 0.402 | 0.399 |

```rust
fn score_21(rank: usize, k: f64) -> f64 {
    1.0 / (k + rank as f64)
}
```

## 第 22 节 · 混合检索与倒数排名融合

稠密向量检索擅长语义近似，但对专有名词与代码标识符的召回不稳定；稀疏检索（BM25）恰好互补。

倒数排名融合（RRF）以 1/(k+rank) 对各路结果加权求和，无需分数归一化，k 取 60 时在多数基准上表现稳健。

评测采用 nDCG@10 与 MRR 两个指标，黄金集为 20 条人工标注的单点定位题；重排阶段再以交叉编码器对前 20 条精排。

守护进程与 CLI 通过 Unix 域套接字通信；断线后 CLI 自动降级为直读 SQLite，恢复后重新接入队列。

所有解析与排版都在 Worker 中完成，主线程只处理输入、DOM overlay 与工具栏；没有跨线程的大对象拷贝。

- 稠密 + 稀疏互补
- RRF 不需要归一化
- 重排只处理前 20 条

| 指标 | 20 | 60 | 100 |
|---|---|---|---|
| nDCG | 0.412 | 0.438 | 0.431 |
| MRR | 0.381 | 0.402 | 0.399 |

```rust
fn score_22(rank: usize, k: f64) -> f64 {
    1.0 / (k + rank as f64)
}
```

## 第 23 节 · 混合检索与倒数排名融合

稠密向量检索擅长语义近似，但对专有名词与代码标识符的召回不稳定；稀疏检索（BM25）恰好互补。

倒数排名融合（RRF）以 1/(k+rank) 对各路结果加权求和，无需分数归一化，k 取 60 时在多数基准上表现稳健。

评测采用 nDCG@10 与 MRR 两个指标，黄金集为 20 条人工标注的单点定位题；重排阶段再以交叉编码器对前 20 条精排。

守护进程与 CLI 通过 Unix 域套接字通信；断线后 CLI 自动降级为直读 SQLite，恢复后重新接入队列。

所有解析与排版都在 Worker 中完成，主线程只处理输入、DOM overlay 与工具栏；没有跨线程的大对象拷贝。

- 稠密 + 稀疏互补
- RRF 不需要归一化
- 重排只处理前 20 条

| 指标 | 20 | 60 | 100 |
|---|---|---|---|
| nDCG | 0.412 | 0.438 | 0.431 |
| MRR | 0.381 | 0.402 | 0.399 |

```rust
fn score_23(rank: usize, k: f64) -> f64 {
    1.0 / (k + rank as f64)
}
```

## 第 24 节 · 混合检索与倒数排名融合

稠密向量检索擅长语义近似，但对专有名词与代码标识符的召回不稳定；稀疏检索（BM25）恰好互补。

倒数排名融合（RRF）以 1/(k+rank) 对各路结果加权求和，无需分数归一化，k 取 60 时在多数基准上表现稳健。

评测采用 nDCG@10 与 MRR 两个指标，黄金集为 20 条人工标注的单点定位题；重排阶段再以交叉编码器对前 20 条精排。

守护进程与 CLI 通过 Unix 域套接字通信；断线后 CLI 自动降级为直读 SQLite，恢复后重新接入队列。

所有解析与排版都在 Worker 中完成，主线程只处理输入、DOM overlay 与工具栏；没有跨线程的大对象拷贝。

- 稠密 + 稀疏互补
- RRF 不需要归一化
- 重排只处理前 20 条

| 指标 | 20 | 60 | 100 |
|---|---|---|---|
| nDCG | 0.412 | 0.438 | 0.431 |
| MRR | 0.381 | 0.402 | 0.399 |

```rust
fn score_24(rank: usize, k: f64) -> f64 {
    1.0 / (k + rank as f64)
}
```

## 第 25 节 · 混合检索与倒数排名融合

稠密向量检索擅长语义近似，但对专有名词与代码标识符的召回不稳定；稀疏检索（BM25）恰好互补。

倒数排名融合（RRF）以 1/(k+rank) 对各路结果加权求和，无需分数归一化，k 取 60 时在多数基准上表现稳健。

评测采用 nDCG@10 与 MRR 两个指标，黄金集为 20 条人工标注的单点定位题；重排阶段再以交叉编码器对前 20 条精排。

守护进程与 CLI 通过 Unix 域套接字通信；断线后 CLI 自动降级为直读 SQLite，恢复后重新接入队列。

所有解析与排版都在 Worker 中完成，主线程只处理输入、DOM overlay 与工具栏；没有跨线程的大对象拷贝。

- 稠密 + 稀疏互补
- RRF 不需要归一化
- 重排只处理前 20 条

| 指标 | 20 | 60 | 100 |
|---|---|---|---|
| nDCG | 0.412 | 0.438 | 0.431 |
| MRR | 0.381 | 0.402 | 0.399 |

```rust
fn score_25(rank: usize, k: f64) -> f64 {
    1.0 / (k + rank as f64)
}
```

## 第 26 节 · 混合检索与倒数排名融合

稠密向量检索擅长语义近似，但对专有名词与代码标识符的召回不稳定；稀疏检索（BM25）恰好互补。

倒数排名融合（RRF）以 1/(k+rank) 对各路结果加权求和，无需分数归一化，k 取 60 时在多数基准上表现稳健。

评测采用 nDCG@10 与 MRR 两个指标，黄金集为 20 条人工标注的单点定位题；重排阶段再以交叉编码器对前 20 条精排。

守护进程与 CLI 通过 Unix 域套接字通信；断线后 CLI 自动降级为直读 SQLite，恢复后重新接入队列。

所有解析与排版都在 Worker 中完成，主线程只处理输入、DOM overlay 与工具栏；没有跨线程的大对象拷贝。

- 稠密 + 稀疏互补
- RRF 不需要归一化
- 重排只处理前 20 条

| 指标 | 20 | 60 | 100 |
|---|---|---|---|
| nDCG | 0.412 | 0.438 | 0.431 |
| MRR | 0.381 | 0.402 | 0.399 |

```rust
fn score_26(rank: usize, k: f64) -> f64 {
    1.0 / (k + rank as f64)
}
```

## 第 27 节 · 混合检索与倒数排名融合

稠密向量检索擅长语义近似，但对专有名词与代码标识符的召回不稳定；稀疏检索（BM25）恰好互补。

倒数排名融合（RRF）以 1/(k+rank) 对各路结果加权求和，无需分数归一化，k 取 60 时在多数基准上表现稳健。

评测采用 nDCG@10 与 MRR 两个指标，黄金集为 20 条人工标注的单点定位题；重排阶段再以交叉编码器对前 20 条精排。

守护进程与 CLI 通过 Unix 域套接字通信；断线后 CLI 自动降级为直读 SQLite，恢复后重新接入队列。

所有解析与排版都在 Worker 中完成，主线程只处理输入、DOM overlay 与工具栏；没有跨线程的大对象拷贝。

- 稠密 + 稀疏互补
- RRF 不需要归一化
- 重排只处理前 20 条

| 指标 | 20 | 60 | 100 |
|---|---|---|---|
| nDCG | 0.412 | 0.438 | 0.431 |
| MRR | 0.381 | 0.402 | 0.399 |

```rust
fn score_27(rank: usize, k: f64) -> f64 {
    1.0 / (k + rank as f64)
}
```

## 第 28 节 · 混合检索与倒数排名融合

稠密向量检索擅长语义近似，但对专有名词与代码标识符的召回不稳定；稀疏检索（BM25）恰好互补。

倒数排名融合（RRF）以 1/(k+rank) 对各路结果加权求和，无需分数归一化，k 取 60 时在多数基准上表现稳健。

评测采用 nDCG@10 与 MRR 两个指标，黄金集为 20 条人工标注的单点定位题；重排阶段再以交叉编码器对前 20 条精排。

守护进程与 CLI 通过 Unix 域套接字通信；断线后 CLI 自动降级为直读 SQLite，恢复后重新接入队列。

所有解析与排版都在 Worker 中完成，主线程只处理输入、DOM overlay 与工具栏；没有跨线程的大对象拷贝。

- 稠密 + 稀疏互补
- RRF 不需要归一化
- 重排只处理前 20 条

| 指标 | 20 | 60 | 100 |
|---|---|---|---|
| nDCG | 0.412 | 0.438 | 0.431 |
| MRR | 0.381 | 0.402 | 0.399 |

```rust
fn score_28(rank: usize, k: f64) -> f64 {
    1.0 / (k + rank as f64)
}
```

## 第 29 节 · 混合检索与倒数排名融合

稠密向量检索擅长语义近似，但对专有名词与代码标识符的召回不稳定；稀疏检索（BM25）恰好互补。

倒数排名融合（RRF）以 1/(k+rank) 对各路结果加权求和，无需分数归一化，k 取 60 时在多数基准上表现稳健。

评测采用 nDCG@10 与 MRR 两个指标，黄金集为 20 条人工标注的单点定位题；重排阶段再以交叉编码器对前 20 条精排。

守护进程与 CLI 通过 Unix 域套接字通信；断线后 CLI 自动降级为直读 SQLite，恢复后重新接入队列。

所有解析与排版都在 Worker 中完成，主线程只处理输入、DOM overlay 与工具栏；没有跨线程的大对象拷贝。

- 稠密 + 稀疏互补
- RRF 不需要归一化
- 重排只处理前 20 条

| 指标 | 20 | 60 | 100 |
|---|---|---|---|
| nDCG | 0.412 | 0.438 | 0.431 |
| MRR | 0.381 | 0.402 | 0.399 |

```rust
fn score_29(rank: usize, k: f64) -> f64 {
    1.0 / (k + rank as f64)
}
```

## 第 30 节 · 混合检索与倒数排名融合

稠密向量检索擅长语义近似，但对专有名词与代码标识符的召回不稳定；稀疏检索（BM25）恰好互补。

倒数排名融合（RRF）以 1/(k+rank) 对各路结果加权求和，无需分数归一化，k 取 60 时在多数基准上表现稳健。

评测采用 nDCG@10 与 MRR 两个指标，黄金集为 20 条人工标注的单点定位题；重排阶段再以交叉编码器对前 20 条精排。

守护进程与 CLI 通过 Unix 域套接字通信；断线后 CLI 自动降级为直读 SQLite，恢复后重新接入队列。

所有解析与排版都在 Worker 中完成，主线程只处理输入、DOM overlay 与工具栏；没有跨线程的大对象拷贝。

- 稠密 + 稀疏互补
- RRF 不需要归一化
- 重排只处理前 20 条

| 指标 | 20 | 60 | 100 |
|---|---|---|---|
| nDCG | 0.412 | 0.438 | 0.431 |
| MRR | 0.381 | 0.402 | 0.399 |

```rust
fn score_30(rank: usize, k: f64) -> f64 {
    1.0 / (k + rank as f64)
}
```

![基准图 30](data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAA8AAAAIcCAIAAAC2P1AsAAASoElEQVR4nO3ce5Tf853H8c/8MpOc7cY1LHbrEhL3S0upu4rIBquEIFmJiBypRkgoYRSpFINVm7qt0lEEpW6pXVbXNa7FaXdru/QYqhrqtCSSkoQZmdk/fj3ZnJnJNC+1fobH46/ffM5nvt/3b37/PPM531/q5i9cUgAAgJVTqfUAAADQmwhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAjU1+rGW2y3e61uDQDAp8MLv3j847+pE2gAAAgIaAAACNTsEY5lanLwDgBA71Xbh4GdQAMAQEBAAwBAQEADAEBAQAMAQEBAAwBAQEADAEBAQAMAQEBAAwBAQEADAEBAQAMAQEBAAwBAQEADAEBAQAMAQEBAAwBAQEADAEBAQAMAQEBAAwBAQEADAEBAQAMAQEBAAwBAQEADAEBAQAMAQEBAAwBAQEADAEBAQAMAQEBAAwBAQEADAEBAQAMAQKC+1gN8SF/caZ9tttmio6MsWrS48dQTd/zSF1a0Ut0/5Cu7Hz121Mpc+Zprbzz2mDHLr7z08ivP/uy/Rh8+4kPMudNuw5954r4V/fihfVTX6eFSd8y+567Z9yxavPiUkybttstO77z7buOZ57399oI11li96dxvrtK/f9c9Tz717PRvX7TeeuuUUnb44nZTJh/7kUwIAPCJ0lsDuqGh4Ybmy0spL7a8fGrjjB/ffn0PK5FrmjsH9KBNBg7aZOBHNXmvMP/tBbPv/vcbrr38N6/OPeGkM+6ZfdP3rrnhSztsd/TYUT+44Zarm2d9Y8rXu+55a978CeOPHHXYwbUeHwDg/1Gvf4Rj8KCNf/+HN3te6WSn3Yafcfb5s26+7Y9/fGfaGTPGT5wyZvzxz/3y+VLKZVc2L168eMJxJy2/rfq6lNJ1/4jDj67eq7W1bfiBo15sefnIcV8/8JCx18+6dUV3/6dLrhhz9KQx449/7fU3ul6weq+Zl1099pjJBx827oGHHi2lvL1g4QknnXHUhMkTjjtp3vy3q9uqe7566FHVPdVf/Ob0pmEHHH7LbbOnnTFj3/0Pq47x0suvdJpq+bdWNW/+2weNHPfSy69Uf1ywYOGRow6tVCrrrbvOggULSylzHntq/+FDSyn7D99nzqNPdbvnzTffWnutAX/+MwMA6M166wn0Mk889czOO+3Q80onrW2t+w/fZ/ddv3zmty4YM3rkttts+cYbv5805bS7fnTdCZMmzLrptuar/nn5bct+8aJLrui0f9jQvR965PHRh494+tmf77Hbzj+89a6Tpxw3aJOBBx4ydtzYI7q99dZbbX7qycfffc9PLrj40tVXW63TBUspbW1ta6y+2qxrL5/72u+OmjB56JA9L7z4suHDhhyw39A7Z99z+ZXN0888pbWttbrnN6/OHT9xytAhe5ZS3m99/4iRB00+7ph99ht5y43fm3rCxFFjvjZu7BE3/fCOTlN1emttbW3fmDa9cdqJyw7aNx644cYDNyyl/OT+h/fea7dSyrx589casGYpZe21BsybN7/bPX94a96rc1+/9rqbV1tt1dNPPXGD9f/uQ32kAACfaL01oNva2o6aMPmDD5b++pVX/+3OG3tYqe4/56xpAzfaoPq6UqnsuvOOpZQnnnzmt3Nfqy4uXvLe0vb2PpX/O5Jftm2ZrvuHD9v7/Au/O/rwEQ/PefyA/fbdfNNB9973wMOPPvnuokXdjl1X6qqxO3zfIRd954qG+vquA7R3tB9y8AGllPU//7fvvrOolPLTp3/27emnlVIO+up++w7dq5TS0dFR3bPRhutX95RSKnWVrbbavE+l0tBQv/WWm1cqlffee7+UcspJkzpN1emtzTj/kgMPGNb1Xx2/nft683U3X998WQ8fxPJ76urqNt900Iyzp93/4Jyzz7nwuu9f2sMvAgD0Ur01oJc939z8g5vuuvveY48Z08NKJ/V96iuVSinlg6UfXHPlJf369W1vb//5fz63fD0vv22ZrvsHbrTBgoUL31206IVftZzVePLESacMG7rXmNGH3vKju7odu65SV+nTp/q6b9+Gtra2rgM0NDSsskr/P+2vqyulLG1f2tFRSil9KpXqt/e67qkuVq/Qr2+/5SefespZnaZa/q21trW2vPTrUsqhI/5h+VEXL15y8rSzzzuncc01Vi+lDBiw5lvz5v/N2mu9+da8AQPW7HbP2H8cue6665RShuy9x/QZF3X7FwAA6O16/TPQu+6y43P//XzPKyuy/Re2rT5A/NgTP726eVZ1sb2jvb29feX3D/nKHtc037jt1lvU1dX98vlfDf/7Ia3vt7a2tnV7haVLlz762FOllPvuf+jLO27f7QUrdZ0/lG233vLBRx4rpdx+579e8t2rut3Tg56n6tvQ9+br/+X1371x2x13L1vs6Og4/cxzxx81ettttqyu7LXHLvfe90Ap5d77Htxzj1263fOdmVc9MueJUspzz/3PpoM3WfkJAQB6kd56Ar3MwI02eLHl5eWTt+vKijSeeuLZMy685bbZ9X36zJh+WnVxh+23m3Ti6Vdd3s0Barf7hw/b+6CR467//qWllNGHjxg99rjNNxu06ir9W1vb+vZt2HDDz1/dPGvihLHVzf369vuPBx5pvu7mVVfpf+45ja3vt3a9YFennXLCmd9quvmWO1fp/9cXnnfWSv9t/qTrVJ02VCqViy/41qgxEzfbbNC2W29ZSrnrx/c+/uTTCxYuvPX22Z/7q89ddflFXzv2qMYzz7v/gTnV/8au2z1TJh97xlnnXX/jrf369uvh7QAA9Gp18xcuqcmNt9hu9+qLF37xeE0GAACgl6ptSfb6RzgAAODjJKABACAgoAEAICCgAQAgIKABACAgoAEAICCgAQAgIKABACAgoAEAICCgAQAgIKABACAgoAEAICCgAQAgIKABACAgoAEAICCgAQAgIKABACAgoAEAICCgAQAgIKABACAgoAEAICCgAQAgIKABACAgoAEAICCgAQAgIKABACAgoAEAICCgAQAgIKABACAgoAEAICCgAQAgIKABACAgoAEAICCgAQAgIKABACAgoAEAICCgAQAgIKABACAgoAEAICCgAQAgIKABACAgoAEAICCgAQAgIKABACAgoAEAICCgAQAgIKABACAgoAEAICCgAQAgIKABACAgoAEAICCgAQAgIKABACAgoAEAICCgAQAgIKABACAgoAEAICCgAQAgIKABACAgoAEAICCgAQAgIKABACAgoAEAICCgAQAgIKABACAgoAEAICCgAQAgUF/rAcoW2+1e6xEAAGBlOYEGAICAgAYAgEDd/IVLaj0DAAD0Gk6gAQAgIKABACAgoAEAICCgAQAgIKABACAgoAEAICCgAQAgIKABACAgoAEAICCgAQAgIKABACAgoAEAIFBf6wEA4NNsamNLbQeY2TS4tgPAp48TaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAjU13oAAD7rpja21HaAmU2DazsA0Ls4gQYAgICABgCAgIAGAICAgAYAgICABgCAgIAGAICAgAYAgICABgCAgIAGAICAgAYAgICABgCAgIAGAICAgAYAgICABgCAgIAGAICAgAYAgICABgCAgIAGAICAgAYAgICABgCAgIAGAICAgAYAgICABgCAgIAGAICAgAYAgICABgCAgIAGAICAgAYAgICABgCAgIAGAICAgAYAgICABgCAgIAGAICAgAYAgICABgCAgIAGAIBAfa0HAODPm9rYUtsBZjYNru0AAJ8cTqABACAgoAEAICCgAQAgIKABACAgoAEAICCgAQAgIKABACAgoAEAICCgAQAgIKABACAgoAEAICCgAQAgIKABACAgoAEAICCgAQAgIKABACAgoAEAICCgAQAgIKABACAgoAEAICCgAQAgIKABACAgoAEAICCgAQAgIKABACAgoAEAICCgAQAgIKABACAgoAEAICCgAQAgIKABACAgoAEAICCgAQAgIKABACAgoAEAICCgAQAgUF/rAQA+GlMbW2o7wMymwbUdAICPhxNoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACNTXegDg4zO1saW2A8xsGlzbAQDgL+cEGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAL1tR4APlmmNrbUdoCZTYNrOwAA0DMn0AAAEBDQAAAQENAAABDwDDQAwGeO7/z8JZxAAwBAQEADAEBAQAMAQEBAAwBAQEADAEBAQAMAQEBAAwBAQEADAEBAQAMAQEBAAwBAQEADAEBAQAMAQEBAAwBAQEADAEBAQAMAQEBAAwBAQEADAEBAQAMAQEBAAwBAQEADAEBAQAMAQEBAAwBAQEADAEBAQAMAQEBAAwBAQEADAEBAQAMAQEBAAwBAQEADAEBAQAMAQEBAAwBAQEADAECgvtYD0PtMbWyp7QAzmwbXdgAA4LPMCTQAAAQENAAABAQ0AAAEPAMNANAN3/lhRZxAAwBAQEADAEBAQAMAQEBAAwBAQEADAEBAQAMAQEBAAwBAQEADAEBAQAMAQEBAAwBAQEADAEBAQAMAQEBAAwBAQEADAEBAQAMAQEBAAwBAQEADAEBAQAMAQEBAAwBAQEADAEBAQAMAQEBAAwBAQEADAEBAQAMAQEBAAwBAQEADAEBAQAMAQEBAAwBAQEADAEBAQAMAQEBAAwBAQEADAECgvtYDfDpNbWyp7QAzmwbXdgAAgE8rJ9AAABAQ0AAAEBDQAAAQ8Aw0APAh+c4Pn01OoAEAICCgAQAgIKABACAgoAEAICCgAQAgIKABACAgoAEAICCgAQAgIKABACAgoAEAICCgAQAgIKABACAgoAEAICCgAQAgIKABACAgoAEAICCgAQAgIKABACAgoAEAICCgAQAgIKABACAgoAEAICCgAQAgIKABACAgoAEAICCgAQAgIKABACAgoAEAICCgAQAgIKABACAgoAEAICCgAQAgUF+rG09tbKnVratmNg2u7QAAAPRGdfMXLqn1DAAA0Gt4hAMAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAAC/wuzN58Z+uwyoQAAAABJRU5ErkJggg==)

## 第 31 节 · 混合检索与倒数排名融合

稠密向量检索擅长语义近似，但对专有名词与代码标识符的召回不稳定；稀疏检索（BM25）恰好互补。

倒数排名融合（RRF）以 1/(k+rank) 对各路结果加权求和，无需分数归一化，k 取 60 时在多数基准上表现稳健。

评测采用 nDCG@10 与 MRR 两个指标，黄金集为 20 条人工标注的单点定位题；重排阶段再以交叉编码器对前 20 条精排。

守护进程与 CLI 通过 Unix 域套接字通信；断线后 CLI 自动降级为直读 SQLite，恢复后重新接入队列。

所有解析与排版都在 Worker 中完成，主线程只处理输入、DOM overlay 与工具栏；没有跨线程的大对象拷贝。

- 稠密 + 稀疏互补
- RRF 不需要归一化
- 重排只处理前 20 条

| 指标 | 20 | 60 | 100 |
|---|---|---|---|
| nDCG | 0.412 | 0.438 | 0.431 |
| MRR | 0.381 | 0.402 | 0.399 |

```rust
fn score_31(rank: usize, k: f64) -> f64 {
    1.0 / (k + rank as f64)
}
```

## 第 32 节 · 混合检索与倒数排名融合

稠密向量检索擅长语义近似，但对专有名词与代码标识符的召回不稳定；稀疏检索（BM25）恰好互补。

倒数排名融合（RRF）以 1/(k+rank) 对各路结果加权求和，无需分数归一化，k 取 60 时在多数基准上表现稳健。

评测采用 nDCG@10 与 MRR 两个指标，黄金集为 20 条人工标注的单点定位题；重排阶段再以交叉编码器对前 20 条精排。

守护进程与 CLI 通过 Unix 域套接字通信；断线后 CLI 自动降级为直读 SQLite，恢复后重新接入队列。

所有解析与排版都在 Worker 中完成，主线程只处理输入、DOM overlay 与工具栏；没有跨线程的大对象拷贝。

- 稠密 + 稀疏互补
- RRF 不需要归一化
- 重排只处理前 20 条

| 指标 | 20 | 60 | 100 |
|---|---|---|---|
| nDCG | 0.412 | 0.438 | 0.431 |
| MRR | 0.381 | 0.402 | 0.399 |

```rust
fn score_32(rank: usize, k: f64) -> f64 {
    1.0 / (k + rank as f64)
}
```

## 第 33 节 · 混合检索与倒数排名融合

稠密向量检索擅长语义近似，但对专有名词与代码标识符的召回不稳定；稀疏检索（BM25）恰好互补。

倒数排名融合（RRF）以 1/(k+rank) 对各路结果加权求和，无需分数归一化，k 取 60 时在多数基准上表现稳健。

评测采用 nDCG@10 与 MRR 两个指标，黄金集为 20 条人工标注的单点定位题；重排阶段再以交叉编码器对前 20 条精排。

守护进程与 CLI 通过 Unix 域套接字通信；断线后 CLI 自动降级为直读 SQLite，恢复后重新接入队列。

所有解析与排版都在 Worker 中完成，主线程只处理输入、DOM overlay 与工具栏；没有跨线程的大对象拷贝。

- 稠密 + 稀疏互补
- RRF 不需要归一化
- 重排只处理前 20 条

| 指标 | 20 | 60 | 100 |
|---|---|---|---|
| nDCG | 0.412 | 0.438 | 0.431 |
| MRR | 0.381 | 0.402 | 0.399 |

```rust
fn score_33(rank: usize, k: f64) -> f64 {
    1.0 / (k + rank as f64)
}
```

## 第 34 节 · 混合检索与倒数排名融合

稠密向量检索擅长语义近似，但对专有名词与代码标识符的召回不稳定；稀疏检索（BM25）恰好互补。

倒数排名融合（RRF）以 1/(k+rank) 对各路结果加权求和，无需分数归一化，k 取 60 时在多数基准上表现稳健。

评测采用 nDCG@10 与 MRR 两个指标，黄金集为 20 条人工标注的单点定位题；重排阶段再以交叉编码器对前 20 条精排。

守护进程与 CLI 通过 Unix 域套接字通信；断线后 CLI 自动降级为直读 SQLite，恢复后重新接入队列。

所有解析与排版都在 Worker 中完成，主线程只处理输入、DOM overlay 与工具栏；没有跨线程的大对象拷贝。

- 稠密 + 稀疏互补
- RRF 不需要归一化
- 重排只处理前 20 条

| 指标 | 20 | 60 | 100 |
|---|---|---|---|
| nDCG | 0.412 | 0.438 | 0.431 |
| MRR | 0.381 | 0.402 | 0.399 |

```rust
fn score_34(rank: usize, k: f64) -> f64 {
    1.0 / (k + rank as f64)
}
```

## 第 35 节 · 混合检索与倒数排名融合

稠密向量检索擅长语义近似，但对专有名词与代码标识符的召回不稳定；稀疏检索（BM25）恰好互补。

倒数排名融合（RRF）以 1/(k+rank) 对各路结果加权求和，无需分数归一化，k 取 60 时在多数基准上表现稳健。

评测采用 nDCG@10 与 MRR 两个指标，黄金集为 20 条人工标注的单点定位题；重排阶段再以交叉编码器对前 20 条精排。

守护进程与 CLI 通过 Unix 域套接字通信；断线后 CLI 自动降级为直读 SQLite，恢复后重新接入队列。

所有解析与排版都在 Worker 中完成，主线程只处理输入、DOM overlay 与工具栏；没有跨线程的大对象拷贝。

- 稠密 + 稀疏互补
- RRF 不需要归一化
- 重排只处理前 20 条

| 指标 | 20 | 60 | 100 |
|---|---|---|---|
| nDCG | 0.412 | 0.438 | 0.431 |
| MRR | 0.381 | 0.402 | 0.399 |

```rust
fn score_35(rank: usize, k: f64) -> f64 {
    1.0 / (k + rank as f64)
}
```

## 第 36 节 · 混合检索与倒数排名融合

稠密向量检索擅长语义近似，但对专有名词与代码标识符的召回不稳定；稀疏检索（BM25）恰好互补。

倒数排名融合（RRF）以 1/(k+rank) 对各路结果加权求和，无需分数归一化，k 取 60 时在多数基准上表现稳健。

评测采用 nDCG@10 与 MRR 两个指标，黄金集为 20 条人工标注的单点定位题；重排阶段再以交叉编码器对前 20 条精排。

守护进程与 CLI 通过 Unix 域套接字通信；断线后 CLI 自动降级为直读 SQLite，恢复后重新接入队列。

所有解析与排版都在 Worker 中完成，主线程只处理输入、DOM overlay 与工具栏；没有跨线程的大对象拷贝。

- 稠密 + 稀疏互补
- RRF 不需要归一化
- 重排只处理前 20 条

| 指标 | 20 | 60 | 100 |
|---|---|---|---|
| nDCG | 0.412 | 0.438 | 0.431 |
| MRR | 0.381 | 0.402 | 0.399 |

```rust
fn score_36(rank: usize, k: f64) -> f64 {
    1.0 / (k + rank as f64)
}
```

## 第 37 节 · 混合检索与倒数排名融合

稠密向量检索擅长语义近似，但对专有名词与代码标识符的召回不稳定；稀疏检索（BM25）恰好互补。

倒数排名融合（RRF）以 1/(k+rank) 对各路结果加权求和，无需分数归一化，k 取 60 时在多数基准上表现稳健。

评测采用 nDCG@10 与 MRR 两个指标，黄金集为 20 条人工标注的单点定位题；重排阶段再以交叉编码器对前 20 条精排。

守护进程与 CLI 通过 Unix 域套接字通信；断线后 CLI 自动降级为直读 SQLite，恢复后重新接入队列。

所有解析与排版都在 Worker 中完成，主线程只处理输入、DOM overlay 与工具栏；没有跨线程的大对象拷贝。

- 稠密 + 稀疏互补
- RRF 不需要归一化
- 重排只处理前 20 条

| 指标 | 20 | 60 | 100 |
|---|---|---|---|
| nDCG | 0.412 | 0.438 | 0.431 |
| MRR | 0.381 | 0.402 | 0.399 |

```rust
fn score_37(rank: usize, k: f64) -> f64 {
    1.0 / (k + rank as f64)
}
```

## 第 38 节 · 混合检索与倒数排名融合

稠密向量检索擅长语义近似，但对专有名词与代码标识符的召回不稳定；稀疏检索（BM25）恰好互补。

倒数排名融合（RRF）以 1/(k+rank) 对各路结果加权求和，无需分数归一化，k 取 60 时在多数基准上表现稳健。

评测采用 nDCG@10 与 MRR 两个指标，黄金集为 20 条人工标注的单点定位题；重排阶段再以交叉编码器对前 20 条精排。

守护进程与 CLI 通过 Unix 域套接字通信；断线后 CLI 自动降级为直读 SQLite，恢复后重新接入队列。

所有解析与排版都在 Worker 中完成，主线程只处理输入、DOM overlay 与工具栏；没有跨线程的大对象拷贝。

- 稠密 + 稀疏互补
- RRF 不需要归一化
- 重排只处理前 20 条

| 指标 | 20 | 60 | 100 |
|---|---|---|---|
| nDCG | 0.412 | 0.438 | 0.431 |
| MRR | 0.381 | 0.402 | 0.399 |

```rust
fn score_38(rank: usize, k: f64) -> f64 {
    1.0 / (k + rank as f64)
}
```

## 第 39 节 · 混合检索与倒数排名融合

稠密向量检索擅长语义近似，但对专有名词与代码标识符的召回不稳定；稀疏检索（BM25）恰好互补。

倒数排名融合（RRF）以 1/(k+rank) 对各路结果加权求和，无需分数归一化，k 取 60 时在多数基准上表现稳健。

评测采用 nDCG@10 与 MRR 两个指标，黄金集为 20 条人工标注的单点定位题；重排阶段再以交叉编码器对前 20 条精排。

守护进程与 CLI 通过 Unix 域套接字通信；断线后 CLI 自动降级为直读 SQLite，恢复后重新接入队列。

所有解析与排版都在 Worker 中完成，主线程只处理输入、DOM overlay 与工具栏；没有跨线程的大对象拷贝。

- 稠密 + 稀疏互补
- RRF 不需要归一化
- 重排只处理前 20 条

| 指标 | 20 | 60 | 100 |
|---|---|---|---|
| nDCG | 0.412 | 0.438 | 0.431 |
| MRR | 0.381 | 0.402 | 0.399 |

```rust
fn score_39(rank: usize, k: f64) -> f64 {
    1.0 / (k + rank as f64)
}
```

## 第 40 节 · 混合检索与倒数排名融合

稠密向量检索擅长语义近似，但对专有名词与代码标识符的召回不稳定；稀疏检索（BM25）恰好互补。

倒数排名融合（RRF）以 1/(k+rank) 对各路结果加权求和，无需分数归一化，k 取 60 时在多数基准上表现稳健。

评测采用 nDCG@10 与 MRR 两个指标，黄金集为 20 条人工标注的单点定位题；重排阶段再以交叉编码器对前 20 条精排。

守护进程与 CLI 通过 Unix 域套接字通信；断线后 CLI 自动降级为直读 SQLite，恢复后重新接入队列。

所有解析与排版都在 Worker 中完成，主线程只处理输入、DOM overlay 与工具栏；没有跨线程的大对象拷贝。

- 稠密 + 稀疏互补
- RRF 不需要归一化
- 重排只处理前 20 条

| 指标 | 20 | 60 | 100 |
|---|---|---|---|
| nDCG | 0.412 | 0.438 | 0.431 |
| MRR | 0.381 | 0.402 | 0.399 |

```rust
fn score_40(rank: usize, k: f64) -> f64 {
    1.0 / (k + rank as f64)
}
```

![基准图 40](data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAA8AAAAIcCAIAAAC2P1AsAAASoElEQVR4nO3ce5Tf853H8c/8MpOc7cY1LHbrEhL3S0upu4rIBquEIFmJiBypRkgoYRSpFINVm7qt0lEEpW6pXVbXNa7FaXdru/QYqhrqtCSSkoQZmdk/fj3ZnJnJNC+1fobH46/ffM5nvt/3b37/PPM531/q5i9cUgAAgJVTqfUAAADQmwhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAjU1+rGW2y3e61uDQDAp8MLv3j847+pE2gAAAgIaAAACNTsEY5lanLwDgBA71Xbh4GdQAMAQEBAAwBAQEADAEBAQAMAQEBAAwBAQEADAEBAQAMAQEBAAwBAQEADAEBAQAMAQEBAAwBAQEADAEBAQAMAQEBAAwBAQEADAEBAQAMAQEBAAwBAQEADAEBAQAMAQEBAAwBAQEADAEBAQAMAQEBAAwBAQEADAEBAQAMAQEBAAwBAQEADAEBAQAMAQKC+1gN8SF/caZ9tttmio6MsWrS48dQTd/zSF1a0Ut0/5Cu7Hz121Mpc+Zprbzz2mDHLr7z08ivP/uy/Rh8+4kPMudNuw5954r4V/fihfVTX6eFSd8y+567Z9yxavPiUkybttstO77z7buOZ57399oI11li96dxvrtK/f9c9Tz717PRvX7TeeuuUUnb44nZTJh/7kUwIAPCJ0lsDuqGh4Ybmy0spL7a8fGrjjB/ffn0PK5FrmjsH9KBNBg7aZOBHNXmvMP/tBbPv/vcbrr38N6/OPeGkM+6ZfdP3rrnhSztsd/TYUT+44Zarm2d9Y8rXu+55a978CeOPHHXYwbUeHwDg/1Gvf4Rj8KCNf/+HN3te6WSn3Yafcfb5s26+7Y9/fGfaGTPGT5wyZvzxz/3y+VLKZVc2L168eMJxJy2/rfq6lNJ1/4jDj67eq7W1bfiBo15sefnIcV8/8JCx18+6dUV3/6dLrhhz9KQx449/7fU3ul6weq+Zl1099pjJBx827oGHHi2lvL1g4QknnXHUhMkTjjtp3vy3q9uqe7566FHVPdVf/Ob0pmEHHH7LbbOnnTFj3/0Pq47x0suvdJpq+bdWNW/+2weNHPfSy69Uf1ywYOGRow6tVCrrrbvOggULSylzHntq/+FDSyn7D99nzqNPdbvnzTffWnutAX/+MwMA6M166wn0Mk889czOO+3Q80onrW2t+w/fZ/ddv3zmty4YM3rkttts+cYbv5805bS7fnTdCZMmzLrptuar/nn5bct+8aJLrui0f9jQvR965PHRh494+tmf77Hbzj+89a6Tpxw3aJOBBx4ydtzYI7q99dZbbX7qycfffc9PLrj40tVXW63TBUspbW1ta6y+2qxrL5/72u+OmjB56JA9L7z4suHDhhyw39A7Z99z+ZXN0888pbWttbrnN6/OHT9xytAhe5ZS3m99/4iRB00+7ph99ht5y43fm3rCxFFjvjZu7BE3/fCOTlN1emttbW3fmDa9cdqJyw7aNx644cYDNyyl/OT+h/fea7dSyrx589casGYpZe21BsybN7/bPX94a96rc1+/9rqbV1tt1dNPPXGD9f/uQ32kAACfaL01oNva2o6aMPmDD5b++pVX/+3OG3tYqe4/56xpAzfaoPq6UqnsuvOOpZQnnnzmt3Nfqy4uXvLe0vb2PpX/O5Jftm2ZrvuHD9v7/Au/O/rwEQ/PefyA/fbdfNNB9973wMOPPvnuokXdjl1X6qqxO3zfIRd954qG+vquA7R3tB9y8AGllPU//7fvvrOolPLTp3/27emnlVIO+up++w7dq5TS0dFR3bPRhutX95RSKnWVrbbavE+l0tBQv/WWm1cqlffee7+UcspJkzpN1emtzTj/kgMPGNb1Xx2/nft683U3X998WQ8fxPJ76urqNt900Iyzp93/4Jyzz7nwuu9f2sMvAgD0Ur01oJc939z8g5vuuvveY48Z08NKJ/V96iuVSinlg6UfXHPlJf369W1vb//5fz63fD0vv22ZrvsHbrTBgoUL31206IVftZzVePLESacMG7rXmNGH3vKju7odu65SV+nTp/q6b9+Gtra2rgM0NDSsskr/P+2vqyulLG1f2tFRSil9KpXqt/e67qkuVq/Qr2+/5SefespZnaZa/q21trW2vPTrUsqhI/5h+VEXL15y8rSzzzuncc01Vi+lDBiw5lvz5v/N2mu9+da8AQPW7HbP2H8cue6665RShuy9x/QZF3X7FwAA6O16/TPQu+6y43P//XzPKyuy/Re2rT5A/NgTP726eVZ1sb2jvb29feX3D/nKHtc037jt1lvU1dX98vlfDf/7Ia3vt7a2tnV7haVLlz762FOllPvuf+jLO27f7QUrdZ0/lG233vLBRx4rpdx+579e8t2rut3Tg56n6tvQ9+br/+X1371x2x13L1vs6Og4/cxzxx81ettttqyu7LXHLvfe90Ap5d77Htxzj1263fOdmVc9MueJUspzz/3PpoM3WfkJAQB6kd56Ar3MwI02eLHl5eWTt+vKijSeeuLZMy685bbZ9X36zJh+WnVxh+23m3Ti6Vdd3s0Barf7hw/b+6CR467//qWllNGHjxg99rjNNxu06ir9W1vb+vZt2HDDz1/dPGvihLHVzf369vuPBx5pvu7mVVfpf+45ja3vt3a9YFennXLCmd9quvmWO1fp/9cXnnfWSv9t/qTrVJ02VCqViy/41qgxEzfbbNC2W29ZSrnrx/c+/uTTCxYuvPX22Z/7q89ddflFXzv2qMYzz7v/gTnV/8au2z1TJh97xlnnXX/jrf369uvh7QAA9Gp18xcuqcmNt9hu9+qLF37xeE0GAACgl6ptSfb6RzgAAODjJKABACAgoAEAICCgAQAgIKABACAgoAEAICCgAQAgIKABACAgoAEAICCgAQAgIKABACAgoAEAICCgAQAgIKABACAgoAEAICCgAQAgIKABACAgoAEAICCgAQAgIKABACAgoAEAICCgAQAgIKABACAgoAEAICCgAQAgIKABACAgoAEAICCgAQAgIKABACAgoAEAICCgAQAgIKABACAgoAEAICCgAQAgIKABACAgoAEAICCgAQAgIKABACAgoAEAICCgAQAgIKABACAgoAEAICCgAQAgIKABACAgoAEAICCgAQAgIKABACAgoAEAICCgAQAgIKABACAgoAEAICCgAQAgIKABACAgoAEAICCgAQAgIKABACAgoAEAICCgAQAgIKABACAgoAEAICCgAQAgIKABACAgoAEAICCgAQAgIKABACAgoAEAICCgAQAgUF/rAcoW2+1e6xEAAGBlOYEGAICAgAYAgEDd/IVLaj0DAAD0Gk6gAQAgIKABACAgoAEAICCgAQAgIKABACAgoAEAICCgAQAgIKABACAgoAEAICCgAQAgIKABACAgoAEAIFBf6wEA4NNsamNLbQeY2TS4tgPAp48TaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAjU13oAAD7rpja21HaAmU2DazsA0Ls4gQYAgICABgCAgIAGAICAgAYAgICABgCAgIAGAICAgAYAgICABgCAgIAGAICAgAYAgICABgCAgIAGAICAgAYAgICABgCAgIAGAICAgAYAgICABgCAgIAGAICAgAYAgICABgCAgIAGAICAgAYAgICABgCAgIAGAICAgAYAgICABgCAgIAGAICAgAYAgICABgCAgIAGAICAgAYAgICABgCAgIAGAICAgAYAgICABgCAgIAGAIBAfa0HAODPm9rYUtsBZjYNru0AAJ8cTqABACAgoAEAICCgAQAgIKABACAgoAEAICCgAQAgIKABACAgoAEAICCgAQAgIKABACAgoAEAICCgAQAgIKABACAgoAEAICCgAQAgIKABACAgoAEAICCgAQAgIKABACAgoAEAICCgAQAgIKABACAgoAEAICCgAQAgIKABACAgoAEAICCgAQAgIKABACAgoAEAICCgAQAgIKABACAgoAEAICCgAQAgIKABACAgoAEAICCgAQAgUF/rAQA+GlMbW2o7wMymwbUdAICPhxNoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACNTXegDg4zO1saW2A8xsGlzbAQDgL+cEGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAL1tR4APlmmNrbUdoCZTYNrOwAA0DMn0AAAEBDQAAAQENAAABDwDDQAwGeO7/z8JZxAAwBAQEADAEBAQAMAQEBAAwBAQEADAEBAQAMAQEBAAwBAQEADAEBAQAMAQEBAAwBAQEADAEBAQAMAQEBAAwBAQEADAEBAQAMAQEBAAwBAQEADAEBAQAMAQEBAAwBAQEADAEBAQAMAQEBAAwBAQEADAEBAQAMAQEBAAwBAQEADAEBAQAMAQEBAAwBAQEADAEBAQAMAQEBAAwBAQEADAECgvtYD0PtMbWyp7QAzmwbXdgAA4LPMCTQAAAQENAAABAQ0AAAEPAMNANAN3/lhRZxAAwBAQEADAEBAQAMAQEBAAwBAQEADAEBAQAMAQEBAAwBAQEADAEBAQAMAQEBAAwBAQEADAEBAQAMAQEBAAwBAQEADAEBAQAMAQEBAAwBAQEADAEBAQAMAQEBAAwBAQEADAEBAQAMAQEBAAwBAQEADAEBAQAMAQEBAAwBAQEADAEBAQAMAQEBAAwBAQEADAEBAQAMAQEBAAwBAQEADAECgvtYDfDpNbWyp7QAzmwbXdgAAgE8rJ9AAABAQ0AAAEBDQAAAQ8Aw0APAh+c4Pn01OoAEAICCgAQAgIKABACAgoAEAICCgAQAgIKABACAgoAEAICCgAQAgIKABACAgoAEAICCgAQAgIKABACAgoAEAICCgAQAgIKABACAgoAEAICCgAQAgIKABACAgoAEAICCgAQAgIKABACAgoAEAICCgAQAgIKABACAgoAEAICCgAQAgIKABACAgoAEAICCgAQAgIKABACAgoAEAICCgAQAgUF+rG09tbKnVratmNg2u7QAAAPRGdfMXLqn1DAAA0Gt4hAMAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAAC/wuzN58Z+uwyoQAAAABJRU5ErkJggg==)

## 第 41 节 · 混合检索与倒数排名融合

稠密向量检索擅长语义近似，但对专有名词与代码标识符的召回不稳定；稀疏检索（BM25）恰好互补。

倒数排名融合（RRF）以 1/(k+rank) 对各路结果加权求和，无需分数归一化，k 取 60 时在多数基准上表现稳健。

评测采用 nDCG@10 与 MRR 两个指标，黄金集为 20 条人工标注的单点定位题；重排阶段再以交叉编码器对前 20 条精排。

守护进程与 CLI 通过 Unix 域套接字通信；断线后 CLI 自动降级为直读 SQLite，恢复后重新接入队列。

所有解析与排版都在 Worker 中完成，主线程只处理输入、DOM overlay 与工具栏；没有跨线程的大对象拷贝。

- 稠密 + 稀疏互补
- RRF 不需要归一化
- 重排只处理前 20 条

| 指标 | 20 | 60 | 100 |
|---|---|---|---|
| nDCG | 0.412 | 0.438 | 0.431 |
| MRR | 0.381 | 0.402 | 0.399 |

```rust
fn score_41(rank: usize, k: f64) -> f64 {
    1.0 / (k + rank as f64)
}
```

## 第 42 节 · 混合检索与倒数排名融合

稠密向量检索擅长语义近似，但对专有名词与代码标识符的召回不稳定；稀疏检索（BM25）恰好互补。

倒数排名融合（RRF）以 1/(k+rank) 对各路结果加权求和，无需分数归一化，k 取 60 时在多数基准上表现稳健。

评测采用 nDCG@10 与 MRR 两个指标，黄金集为 20 条人工标注的单点定位题；重排阶段再以交叉编码器对前 20 条精排。

守护进程与 CLI 通过 Unix 域套接字通信；断线后 CLI 自动降级为直读 SQLite，恢复后重新接入队列。

所有解析与排版都在 Worker 中完成，主线程只处理输入、DOM overlay 与工具栏；没有跨线程的大对象拷贝。

- 稠密 + 稀疏互补
- RRF 不需要归一化
- 重排只处理前 20 条

| 指标 | 20 | 60 | 100 |
|---|---|---|---|
| nDCG | 0.412 | 0.438 | 0.431 |
| MRR | 0.381 | 0.402 | 0.399 |

```rust
fn score_42(rank: usize, k: f64) -> f64 {
    1.0 / (k + rank as f64)
}
```

## 第 43 节 · 混合检索与倒数排名融合

稠密向量检索擅长语义近似，但对专有名词与代码标识符的召回不稳定；稀疏检索（BM25）恰好互补。

倒数排名融合（RRF）以 1/(k+rank) 对各路结果加权求和，无需分数归一化，k 取 60 时在多数基准上表现稳健。

评测采用 nDCG@10 与 MRR 两个指标，黄金集为 20 条人工标注的单点定位题；重排阶段再以交叉编码器对前 20 条精排。

守护进程与 CLI 通过 Unix 域套接字通信；断线后 CLI 自动降级为直读 SQLite，恢复后重新接入队列。

所有解析与排版都在 Worker 中完成，主线程只处理输入、DOM overlay 与工具栏；没有跨线程的大对象拷贝。

- 稠密 + 稀疏互补
- RRF 不需要归一化
- 重排只处理前 20 条

| 指标 | 20 | 60 | 100 |
|---|---|---|---|
| nDCG | 0.412 | 0.438 | 0.431 |
| MRR | 0.381 | 0.402 | 0.399 |

```rust
fn score_43(rank: usize, k: f64) -> f64 {
    1.0 / (k + rank as f64)
}
```

## 第 44 节 · 混合检索与倒数排名融合

稠密向量检索擅长语义近似，但对专有名词与代码标识符的召回不稳定；稀疏检索（BM25）恰好互补。

倒数排名融合（RRF）以 1/(k+rank) 对各路结果加权求和，无需分数归一化，k 取 60 时在多数基准上表现稳健。

评测采用 nDCG@10 与 MRR 两个指标，黄金集为 20 条人工标注的单点定位题；重排阶段再以交叉编码器对前 20 条精排。

守护进程与 CLI 通过 Unix 域套接字通信；断线后 CLI 自动降级为直读 SQLite，恢复后重新接入队列。

所有解析与排版都在 Worker 中完成，主线程只处理输入、DOM overlay 与工具栏；没有跨线程的大对象拷贝。

- 稠密 + 稀疏互补
- RRF 不需要归一化
- 重排只处理前 20 条

| 指标 | 20 | 60 | 100 |
|---|---|---|---|
| nDCG | 0.412 | 0.438 | 0.431 |
| MRR | 0.381 | 0.402 | 0.399 |

```rust
fn score_44(rank: usize, k: f64) -> f64 {
    1.0 / (k + rank as f64)
}
```

## 第 45 节 · 混合检索与倒数排名融合

稠密向量检索擅长语义近似，但对专有名词与代码标识符的召回不稳定；稀疏检索（BM25）恰好互补。

倒数排名融合（RRF）以 1/(k+rank) 对各路结果加权求和，无需分数归一化，k 取 60 时在多数基准上表现稳健。

评测采用 nDCG@10 与 MRR 两个指标，黄金集为 20 条人工标注的单点定位题；重排阶段再以交叉编码器对前 20 条精排。

守护进程与 CLI 通过 Unix 域套接字通信；断线后 CLI 自动降级为直读 SQLite，恢复后重新接入队列。

所有解析与排版都在 Worker 中完成，主线程只处理输入、DOM overlay 与工具栏；没有跨线程的大对象拷贝。

- 稠密 + 稀疏互补
- RRF 不需要归一化
- 重排只处理前 20 条

| 指标 | 20 | 60 | 100 |
|---|---|---|---|
| nDCG | 0.412 | 0.438 | 0.431 |
| MRR | 0.381 | 0.402 | 0.399 |

```rust
fn score_45(rank: usize, k: f64) -> f64 {
    1.0 / (k + rank as f64)
}
```

## 第 46 节 · 混合检索与倒数排名融合

稠密向量检索擅长语义近似，但对专有名词与代码标识符的召回不稳定；稀疏检索（BM25）恰好互补。

倒数排名融合（RRF）以 1/(k+rank) 对各路结果加权求和，无需分数归一化，k 取 60 时在多数基准上表现稳健。

评测采用 nDCG@10 与 MRR 两个指标，黄金集为 20 条人工标注的单点定位题；重排阶段再以交叉编码器对前 20 条精排。

守护进程与 CLI 通过 Unix 域套接字通信；断线后 CLI 自动降级为直读 SQLite，恢复后重新接入队列。

所有解析与排版都在 Worker 中完成，主线程只处理输入、DOM overlay 与工具栏；没有跨线程的大对象拷贝。

- 稠密 + 稀疏互补
- RRF 不需要归一化
- 重排只处理前 20 条

| 指标 | 20 | 60 | 100 |
|---|---|---|---|
| nDCG | 0.412 | 0.438 | 0.431 |
| MRR | 0.381 | 0.402 | 0.399 |

```rust
fn score_46(rank: usize, k: f64) -> f64 {
    1.0 / (k + rank as f64)
}
```

## 第 47 节 · 混合检索与倒数排名融合

稠密向量检索擅长语义近似，但对专有名词与代码标识符的召回不稳定；稀疏检索（BM25）恰好互补。

倒数排名融合（RRF）以 1/(k+rank) 对各路结果加权求和，无需分数归一化，k 取 60 时在多数基准上表现稳健。

评测采用 nDCG@10 与 MRR 两个指标，黄金集为 20 条人工标注的单点定位题；重排阶段再以交叉编码器对前 20 条精排。

守护进程与 CLI 通过 Unix 域套接字通信；断线后 CLI 自动降级为直读 SQLite，恢复后重新接入队列。

所有解析与排版都在 Worker 中完成，主线程只处理输入、DOM overlay 与工具栏；没有跨线程的大对象拷贝。

- 稠密 + 稀疏互补
- RRF 不需要归一化
- 重排只处理前 20 条

| 指标 | 20 | 60 | 100 |
|---|---|---|---|
| nDCG | 0.412 | 0.438 | 0.431 |
| MRR | 0.381 | 0.402 | 0.399 |

```rust
fn score_47(rank: usize, k: f64) -> f64 {
    1.0 / (k + rank as f64)
}
```

## 第 48 节 · 混合检索与倒数排名融合

稠密向量检索擅长语义近似，但对专有名词与代码标识符的召回不稳定；稀疏检索（BM25）恰好互补。

倒数排名融合（RRF）以 1/(k+rank) 对各路结果加权求和，无需分数归一化，k 取 60 时在多数基准上表现稳健。

评测采用 nDCG@10 与 MRR 两个指标，黄金集为 20 条人工标注的单点定位题；重排阶段再以交叉编码器对前 20 条精排。

守护进程与 CLI 通过 Unix 域套接字通信；断线后 CLI 自动降级为直读 SQLite，恢复后重新接入队列。

所有解析与排版都在 Worker 中完成，主线程只处理输入、DOM overlay 与工具栏；没有跨线程的大对象拷贝。

- 稠密 + 稀疏互补
- RRF 不需要归一化
- 重排只处理前 20 条

| 指标 | 20 | 60 | 100 |
|---|---|---|---|
| nDCG | 0.412 | 0.438 | 0.431 |
| MRR | 0.381 | 0.402 | 0.399 |

```rust
fn score_48(rank: usize, k: f64) -> f64 {
    1.0 / (k + rank as f64)
}
```

## 第 49 节 · 混合检索与倒数排名融合

稠密向量检索擅长语义近似，但对专有名词与代码标识符的召回不稳定；稀疏检索（BM25）恰好互补。

倒数排名融合（RRF）以 1/(k+rank) 对各路结果加权求和，无需分数归一化，k 取 60 时在多数基准上表现稳健。

评测采用 nDCG@10 与 MRR 两个指标，黄金集为 20 条人工标注的单点定位题；重排阶段再以交叉编码器对前 20 条精排。

守护进程与 CLI 通过 Unix 域套接字通信；断线后 CLI 自动降级为直读 SQLite，恢复后重新接入队列。

所有解析与排版都在 Worker 中完成，主线程只处理输入、DOM overlay 与工具栏；没有跨线程的大对象拷贝。

- 稠密 + 稀疏互补
- RRF 不需要归一化
- 重排只处理前 20 条

| 指标 | 20 | 60 | 100 |
|---|---|---|---|
| nDCG | 0.412 | 0.438 | 0.431 |
| MRR | 0.381 | 0.402 | 0.399 |

```rust
fn score_49(rank: usize, k: f64) -> f64 {
    1.0 / (k + rank as f64)
}
```

## 第 50 节 · 混合检索与倒数排名融合

稠密向量检索擅长语义近似，但对专有名词与代码标识符的召回不稳定；稀疏检索（BM25）恰好互补。

倒数排名融合（RRF）以 1/(k+rank) 对各路结果加权求和，无需分数归一化，k 取 60 时在多数基准上表现稳健。

评测采用 nDCG@10 与 MRR 两个指标，黄金集为 20 条人工标注的单点定位题；重排阶段再以交叉编码器对前 20 条精排。

守护进程与 CLI 通过 Unix 域套接字通信；断线后 CLI 自动降级为直读 SQLite，恢复后重新接入队列。

所有解析与排版都在 Worker 中完成，主线程只处理输入、DOM overlay 与工具栏；没有跨线程的大对象拷贝。

- 稠密 + 稀疏互补
- RRF 不需要归一化
- 重排只处理前 20 条

| 指标 | 20 | 60 | 100 |
|---|---|---|---|
| nDCG | 0.412 | 0.438 | 0.431 |
| MRR | 0.381 | 0.402 | 0.399 |

```rust
fn score_50(rank: usize, k: f64) -> f64 {
    1.0 / (k + rank as f64)
}
```

![基准图 50](data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAA8AAAAIcCAIAAAC2P1AsAAASoElEQVR4nO3ce5Tf853H8c/8MpOc7cY1LHbrEhL3S0upu4rIBquEIFmJiBypRkgoYRSpFINVm7qt0lEEpW6pXVbXNa7FaXdru/QYqhrqtCSSkoQZmdk/fj3ZnJnJNC+1fobH46/ffM5nvt/3b37/PPM531/q5i9cUgAAgJVTqfUAAADQmwhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAjU1+rGW2y3e61uDQDAp8MLv3j847+pE2gAAAgIaAAACNTsEY5lanLwDgBA71Xbh4GdQAMAQEBAAwBAQEADAEBAQAMAQEBAAwBAQEADAEBAQAMAQEBAAwBAQEADAEBAQAMAQEBAAwBAQEADAEBAQAMAQEBAAwBAQEADAEBAQAMAQEBAAwBAQEADAEBAQAMAQEBAAwBAQEADAEBAQAMAQEBAAwBAQEADAEBAQAMAQEBAAwBAQEADAEBAQAMAQKC+1gN8SF/caZ9tttmio6MsWrS48dQTd/zSF1a0Ut0/5Cu7Hz121Mpc+Zprbzz2mDHLr7z08ivP/uy/Rh8+4kPMudNuw5954r4V/fihfVTX6eFSd8y+567Z9yxavPiUkybttstO77z7buOZ57399oI11li96dxvrtK/f9c9Tz717PRvX7TeeuuUUnb44nZTJh/7kUwIAPCJ0lsDuqGh4Ybmy0spL7a8fGrjjB/ffn0PK5FrmjsH9KBNBg7aZOBHNXmvMP/tBbPv/vcbrr38N6/OPeGkM+6ZfdP3rrnhSztsd/TYUT+44Zarm2d9Y8rXu+55a978CeOPHHXYwbUeHwDg/1Gvf4Rj8KCNf/+HN3te6WSn3Yafcfb5s26+7Y9/fGfaGTPGT5wyZvzxz/3y+VLKZVc2L168eMJxJy2/rfq6lNJ1/4jDj67eq7W1bfiBo15sefnIcV8/8JCx18+6dUV3/6dLrhhz9KQx449/7fU3ul6weq+Zl1099pjJBx827oGHHi2lvL1g4QknnXHUhMkTjjtp3vy3q9uqe7566FHVPdVf/Ob0pmEHHH7LbbOnnTFj3/0Pq47x0suvdJpq+bdWNW/+2weNHPfSy69Uf1ywYOGRow6tVCrrrbvOggULSylzHntq/+FDSyn7D99nzqNPdbvnzTffWnutAX/+MwMA6M166wn0Mk889czOO+3Q80onrW2t+w/fZ/ddv3zmty4YM3rkttts+cYbv5805bS7fnTdCZMmzLrptuar/nn5bct+8aJLrui0f9jQvR965PHRh494+tmf77Hbzj+89a6Tpxw3aJOBBx4ydtzYI7q99dZbbX7qycfffc9PLrj40tVXW63TBUspbW1ta6y+2qxrL5/72u+OmjB56JA9L7z4suHDhhyw39A7Z99z+ZXN0888pbWttbrnN6/OHT9xytAhe5ZS3m99/4iRB00+7ph99ht5y43fm3rCxFFjvjZu7BE3/fCOTlN1emttbW3fmDa9cdqJyw7aNx644cYDNyyl/OT+h/fea7dSyrx589casGYpZe21BsybN7/bPX94a96rc1+/9rqbV1tt1dNPPXGD9f/uQ32kAACfaL01oNva2o6aMPmDD5b++pVX/+3OG3tYqe4/56xpAzfaoPq6UqnsuvOOpZQnnnzmt3Nfqy4uXvLe0vb2PpX/O5Jftm2ZrvuHD9v7/Au/O/rwEQ/PefyA/fbdfNNB9973wMOPPvnuokXdjl1X6qqxO3zfIRd954qG+vquA7R3tB9y8AGllPU//7fvvrOolPLTp3/27emnlVIO+up++w7dq5TS0dFR3bPRhutX95RSKnWVrbbavE+l0tBQv/WWm1cqlffee7+UcspJkzpN1emtzTj/kgMPGNb1Xx2/nft683U3X998WQ8fxPJ76urqNt900Iyzp93/4Jyzz7nwuu9f2sMvAgD0Ur01oJc939z8g5vuuvveY48Z08NKJ/V96iuVSinlg6UfXHPlJf369W1vb//5fz63fD0vv22ZrvsHbrTBgoUL31206IVftZzVePLESacMG7rXmNGH3vKju7odu65SV+nTp/q6b9+Gtra2rgM0NDSsskr/P+2vqyulLG1f2tFRSil9KpXqt/e67qkuVq/Qr2+/5SefespZnaZa/q21trW2vPTrUsqhI/5h+VEXL15y8rSzzzuncc01Vi+lDBiw5lvz5v/N2mu9+da8AQPW7HbP2H8cue6665RShuy9x/QZF3X7FwAA6O16/TPQu+6y43P//XzPKyuy/Re2rT5A/NgTP726eVZ1sb2jvb29feX3D/nKHtc037jt1lvU1dX98vlfDf/7Ia3vt7a2tnV7haVLlz762FOllPvuf+jLO27f7QUrdZ0/lG233vLBRx4rpdx+579e8t2rut3Tg56n6tvQ9+br/+X1371x2x13L1vs6Og4/cxzxx81ettttqyu7LXHLvfe90Ap5d77Htxzj1263fOdmVc9MueJUspzz/3PpoM3WfkJAQB6kd56Ar3MwI02eLHl5eWTt+vKijSeeuLZMy685bbZ9X36zJh+WnVxh+23m3Ti6Vdd3s0Barf7hw/b+6CR467//qWllNGHjxg99rjNNxu06ir9W1vb+vZt2HDDz1/dPGvihLHVzf369vuPBx5pvu7mVVfpf+45ja3vt3a9YFennXLCmd9quvmWO1fp/9cXnnfWSv9t/qTrVJ02VCqViy/41qgxEzfbbNC2W29ZSrnrx/c+/uTTCxYuvPX22Z/7q89ddflFXzv2qMYzz7v/gTnV/8au2z1TJh97xlnnXX/jrf369uvh7QAA9Gp18xcuqcmNt9hu9+qLF37xeE0GAACgl6ptSfb6RzgAAODjJKABACAgoAEAICCgAQAgIKABACAgoAEAICCgAQAgIKABACAgoAEAICCgAQAgIKABACAgoAEAICCgAQAgIKABACAgoAEAICCgAQAgIKABACAgoAEAICCgAQAgIKABACAgoAEAICCgAQAgIKABACAgoAEAICCgAQAgIKABACAgoAEAICCgAQAgIKABACAgoAEAICCgAQAgIKABACAgoAEAICCgAQAgIKABACAgoAEAICCgAQAgIKABACAgoAEAICCgAQAgIKABACAgoAEAICCgAQAgIKABACAgoAEAICCgAQAgIKABACAgoAEAICCgAQAgIKABACAgoAEAICCgAQAgIKABACAgoAEAICCgAQAgIKABACAgoAEAICCgAQAgIKABACAgoAEAICCgAQAgIKABACAgoAEAICCgAQAgIKABACAgoAEAICCgAQAgUF/rAcoW2+1e6xEAAGBlOYEGAICAgAYAgEDd/IVLaj0DAAD0Gk6gAQAgIKABACAgoAEAICCgAQAgIKABACAgoAEAICCgAQAgIKABACAgoAEAICCgAQAgIKABACAgoAEAIFBf6wEA4NNsamNLbQeY2TS4tgPAp48TaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAjU13oAAD7rpja21HaAmU2DazsA0Ls4gQYAgICABgCAgIAGAICAgAYAgICABgCAgIAGAICAgAYAgICABgCAgIAGAICAgAYAgICABgCAgIAGAICAgAYAgICABgCAgIAGAICAgAYAgICABgCAgIAGAICAgAYAgICABgCAgIAGAICAgAYAgICABgCAgIAGAICAgAYAgICABgCAgIAGAICAgAYAgICABgCAgIAGAICAgAYAgICABgCAgIAGAICAgAYAgICABgCAgIAGAIBAfa0HAODPm9rYUtsBZjYNru0AAJ8cTqABACAgoAEAICCgAQAgIKABACAgoAEAICCgAQAgIKABACAgoAEAICCgAQAgIKABACAgoAEAICCgAQAgIKABACAgoAEAICCgAQAgIKABACAgoAEAICCgAQAgIKABACAgoAEAICCgAQAgIKABACAgoAEAICCgAQAgIKABACAgoAEAICCgAQAgIKABACAgoAEAICCgAQAgIKABACAgoAEAICCgAQAgIKABACAgoAEAICCgAQAgUF/rAQA+GlMbW2o7wMymwbUdAICPhxNoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACNTXegDg4zO1saW2A8xsGlzbAQDgL+cEGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAL1tR4APlmmNrbUdoCZTYNrOwAA0DMn0AAAEBDQAAAQENAAABDwDDQAwGeO7/z8JZxAAwBAQEADAEBAQAMAQEBAAwBAQEADAEBAQAMAQEBAAwBAQEADAEBAQAMAQEBAAwBAQEADAEBAQAMAQEBAAwBAQEADAEBAQAMAQEBAAwBAQEADAEBAQAMAQEBAAwBAQEADAEBAQAMAQEBAAwBAQEADAEBAQAMAQEBAAwBAQEADAEBAQAMAQEBAAwBAQEADAEBAQAMAQEBAAwBAQEADAECgvtYD0PtMbWyp7QAzmwbXdgAA4LPMCTQAAAQENAAABAQ0AAAEPAMNANAN3/lhRZxAAwBAQEADAEBAQAMAQEBAAwBAQEADAEBAQAMAQEBAAwBAQEADAEBAQAMAQEBAAwBAQEADAEBAQAMAQEBAAwBAQEADAEBAQAMAQEBAAwBAQEADAEBAQAMAQEBAAwBAQEADAEBAQAMAQEBAAwBAQEADAEBAQAMAQEBAAwBAQEADAEBAQAMAQEBAAwBAQEADAEBAQAMAQEBAAwBAQEADAECgvtYDfDpNbWyp7QAzmwbXdgAAgE8rJ9AAABAQ0AAAEBDQAAAQ8Aw0APAh+c4Pn01OoAEAICCgAQAgIKABACAgoAEAICCgAQAgIKABACAgoAEAICCgAQAgIKABACAgoAEAICCgAQAgIKABACAgoAEAICCgAQAgIKABACAgoAEAICCgAQAgIKABACAgoAEAICCgAQAgIKABACAgoAEAICCgAQAgIKABACAgoAEAICCgAQAgIKABACAgoAEAICCgAQAgIKABACAgoAEAICCgAQAgUF+rG09tbKnVratmNg2u7QAAAPRGdfMXLqn1DAAA0Gt4hAMAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAAC/wuzN58Z+uwyoQAAAABJRU5ErkJggg==)

## 第 51 节 · 混合检索与倒数排名融合

稠密向量检索擅长语义近似，但对专有名词与代码标识符的召回不稳定；稀疏检索（BM25）恰好互补。

倒数排名融合（RRF）以 1/(k+rank) 对各路结果加权求和，无需分数归一化，k 取 60 时在多数基准上表现稳健。

评测采用 nDCG@10 与 MRR 两个指标，黄金集为 20 条人工标注的单点定位题；重排阶段再以交叉编码器对前 20 条精排。

守护进程与 CLI 通过 Unix 域套接字通信；断线后 CLI 自动降级为直读 SQLite，恢复后重新接入队列。

所有解析与排版都在 Worker 中完成，主线程只处理输入、DOM overlay 与工具栏；没有跨线程的大对象拷贝。

- 稠密 + 稀疏互补
- RRF 不需要归一化
- 重排只处理前 20 条

| 指标 | 20 | 60 | 100 |
|---|---|---|---|
| nDCG | 0.412 | 0.438 | 0.431 |
| MRR | 0.381 | 0.402 | 0.399 |

```rust
fn score_51(rank: usize, k: f64) -> f64 {
    1.0 / (k + rank as f64)
}
```

## 第 52 节 · 混合检索与倒数排名融合

稠密向量检索擅长语义近似，但对专有名词与代码标识符的召回不稳定；稀疏检索（BM25）恰好互补。

倒数排名融合（RRF）以 1/(k+rank) 对各路结果加权求和，无需分数归一化，k 取 60 时在多数基准上表现稳健。

评测采用 nDCG@10 与 MRR 两个指标，黄金集为 20 条人工标注的单点定位题；重排阶段再以交叉编码器对前 20 条精排。

守护进程与 CLI 通过 Unix 域套接字通信；断线后 CLI 自动降级为直读 SQLite，恢复后重新接入队列。

所有解析与排版都在 Worker 中完成，主线程只处理输入、DOM overlay 与工具栏；没有跨线程的大对象拷贝。

- 稠密 + 稀疏互补
- RRF 不需要归一化
- 重排只处理前 20 条

| 指标 | 20 | 60 | 100 |
|---|---|---|---|
| nDCG | 0.412 | 0.438 | 0.431 |
| MRR | 0.381 | 0.402 | 0.399 |

```rust
fn score_52(rank: usize, k: f64) -> f64 {
    1.0 / (k + rank as f64)
}
```

## 第 53 节 · 混合检索与倒数排名融合

稠密向量检索擅长语义近似，但对专有名词与代码标识符的召回不稳定；稀疏检索（BM25）恰好互补。

倒数排名融合（RRF）以 1/(k+rank) 对各路结果加权求和，无需分数归一化，k 取 60 时在多数基准上表现稳健。

评测采用 nDCG@10 与 MRR 两个指标，黄金集为 20 条人工标注的单点定位题；重排阶段再以交叉编码器对前 20 条精排。

守护进程与 CLI 通过 Unix 域套接字通信；断线后 CLI 自动降级为直读 SQLite，恢复后重新接入队列。

所有解析与排版都在 Worker 中完成，主线程只处理输入、DOM overlay 与工具栏；没有跨线程的大对象拷贝。

- 稠密 + 稀疏互补
- RRF 不需要归一化
- 重排只处理前 20 条

| 指标 | 20 | 60 | 100 |
|---|---|---|---|
| nDCG | 0.412 | 0.438 | 0.431 |
| MRR | 0.381 | 0.402 | 0.399 |

```rust
fn score_53(rank: usize, k: f64) -> f64 {
    1.0 / (k + rank as f64)
}
```

## 第 54 节 · 混合检索与倒数排名融合

稠密向量检索擅长语义近似，但对专有名词与代码标识符的召回不稳定；稀疏检索（BM25）恰好互补。

倒数排名融合（RRF）以 1/(k+rank) 对各路结果加权求和，无需分数归一化，k 取 60 时在多数基准上表现稳健。

评测采用 nDCG@10 与 MRR 两个指标，黄金集为 20 条人工标注的单点定位题；重排阶段再以交叉编码器对前 20 条精排。

守护进程与 CLI 通过 Unix 域套接字通信；断线后 CLI 自动降级为直读 SQLite，恢复后重新接入队列。

所有解析与排版都在 Worker 中完成，主线程只处理输入、DOM overlay 与工具栏；没有跨线程的大对象拷贝。

- 稠密 + 稀疏互补
- RRF 不需要归一化
- 重排只处理前 20 条

| 指标 | 20 | 60 | 100 |
|---|---|---|---|
| nDCG | 0.412 | 0.438 | 0.431 |
| MRR | 0.381 | 0.402 | 0.399 |

```rust
fn score_54(rank: usize, k: f64) -> f64 {
    1.0 / (k + rank as f64)
}
```

## 第 55 节 · 混合检索与倒数排名融合

稠密向量检索擅长语义近似，但对专有名词与代码标识符的召回不稳定；稀疏检索（BM25）恰好互补。

倒数排名融合（RRF）以 1/(k+rank) 对各路结果加权求和，无需分数归一化，k 取 60 时在多数基准上表现稳健。

评测采用 nDCG@10 与 MRR 两个指标，黄金集为 20 条人工标注的单点定位题；重排阶段再以交叉编码器对前 20 条精排。

守护进程与 CLI 通过 Unix 域套接字通信；断线后 CLI 自动降级为直读 SQLite，恢复后重新接入队列。

所有解析与排版都在 Worker 中完成，主线程只处理输入、DOM overlay 与工具栏；没有跨线程的大对象拷贝。

- 稠密 + 稀疏互补
- RRF 不需要归一化
- 重排只处理前 20 条

| 指标 | 20 | 60 | 100 |
|---|---|---|---|
| nDCG | 0.412 | 0.438 | 0.431 |
| MRR | 0.381 | 0.402 | 0.399 |

```rust
fn score_55(rank: usize, k: f64) -> f64 {
    1.0 / (k + rank as f64)
}
```

## 第 56 节 · 混合检索与倒数排名融合

稠密向量检索擅长语义近似，但对专有名词与代码标识符的召回不稳定；稀疏检索（BM25）恰好互补。

倒数排名融合（RRF）以 1/(k+rank) 对各路结果加权求和，无需分数归一化，k 取 60 时在多数基准上表现稳健。

评测采用 nDCG@10 与 MRR 两个指标，黄金集为 20 条人工标注的单点定位题；重排阶段再以交叉编码器对前 20 条精排。

守护进程与 CLI 通过 Unix 域套接字通信；断线后 CLI 自动降级为直读 SQLite，恢复后重新接入队列。

所有解析与排版都在 Worker 中完成，主线程只处理输入、DOM overlay 与工具栏；没有跨线程的大对象拷贝。

- 稠密 + 稀疏互补
- RRF 不需要归一化
- 重排只处理前 20 条

| 指标 | 20 | 60 | 100 |
|---|---|---|---|
| nDCG | 0.412 | 0.438 | 0.431 |
| MRR | 0.381 | 0.402 | 0.399 |

```rust
fn score_56(rank: usize, k: f64) -> f64 {
    1.0 / (k + rank as f64)
}
```

## 第 57 节 · 混合检索与倒数排名融合

稠密向量检索擅长语义近似，但对专有名词与代码标识符的召回不稳定；稀疏检索（BM25）恰好互补。

倒数排名融合（RRF）以 1/(k+rank) 对各路结果加权求和，无需分数归一化，k 取 60 时在多数基准上表现稳健。

评测采用 nDCG@10 与 MRR 两个指标，黄金集为 20 条人工标注的单点定位题；重排阶段再以交叉编码器对前 20 条精排。

守护进程与 CLI 通过 Unix 域套接字通信；断线后 CLI 自动降级为直读 SQLite，恢复后重新接入队列。

所有解析与排版都在 Worker 中完成，主线程只处理输入、DOM overlay 与工具栏；没有跨线程的大对象拷贝。

- 稠密 + 稀疏互补
- RRF 不需要归一化
- 重排只处理前 20 条

| 指标 | 20 | 60 | 100 |
|---|---|---|---|
| nDCG | 0.412 | 0.438 | 0.431 |
| MRR | 0.381 | 0.402 | 0.399 |

```rust
fn score_57(rank: usize, k: f64) -> f64 {
    1.0 / (k + rank as f64)
}
```

## 第 58 节 · 混合检索与倒数排名融合

稠密向量检索擅长语义近似，但对专有名词与代码标识符的召回不稳定；稀疏检索（BM25）恰好互补。

倒数排名融合（RRF）以 1/(k+rank) 对各路结果加权求和，无需分数归一化，k 取 60 时在多数基准上表现稳健。

评测采用 nDCG@10 与 MRR 两个指标，黄金集为 20 条人工标注的单点定位题；重排阶段再以交叉编码器对前 20 条精排。

守护进程与 CLI 通过 Unix 域套接字通信；断线后 CLI 自动降级为直读 SQLite，恢复后重新接入队列。

所有解析与排版都在 Worker 中完成，主线程只处理输入、DOM overlay 与工具栏；没有跨线程的大对象拷贝。

- 稠密 + 稀疏互补
- RRF 不需要归一化
- 重排只处理前 20 条

| 指标 | 20 | 60 | 100 |
|---|---|---|---|
| nDCG | 0.412 | 0.438 | 0.431 |
| MRR | 0.381 | 0.402 | 0.399 |

```rust
fn score_58(rank: usize, k: f64) -> f64 {
    1.0 / (k + rank as f64)
}
```

## 第 59 节 · 混合检索与倒数排名融合

稠密向量检索擅长语义近似，但对专有名词与代码标识符的召回不稳定；稀疏检索（BM25）恰好互补。

倒数排名融合（RRF）以 1/(k+rank) 对各路结果加权求和，无需分数归一化，k 取 60 时在多数基准上表现稳健。

评测采用 nDCG@10 与 MRR 两个指标，黄金集为 20 条人工标注的单点定位题；重排阶段再以交叉编码器对前 20 条精排。

守护进程与 CLI 通过 Unix 域套接字通信；断线后 CLI 自动降级为直读 SQLite，恢复后重新接入队列。

所有解析与排版都在 Worker 中完成，主线程只处理输入、DOM overlay 与工具栏；没有跨线程的大对象拷贝。

- 稠密 + 稀疏互补
- RRF 不需要归一化
- 重排只处理前 20 条

| 指标 | 20 | 60 | 100 |
|---|---|---|---|
| nDCG | 0.412 | 0.438 | 0.431 |
| MRR | 0.381 | 0.402 | 0.399 |

```rust
fn score_59(rank: usize, k: f64) -> f64 {
    1.0 / (k + rank as f64)
}
```

## 第 60 节 · 混合检索与倒数排名融合

稠密向量检索擅长语义近似，但对专有名词与代码标识符的召回不稳定；稀疏检索（BM25）恰好互补。

倒数排名融合（RRF）以 1/(k+rank) 对各路结果加权求和，无需分数归一化，k 取 60 时在多数基准上表现稳健。

评测采用 nDCG@10 与 MRR 两个指标，黄金集为 20 条人工标注的单点定位题；重排阶段再以交叉编码器对前 20 条精排。

守护进程与 CLI 通过 Unix 域套接字通信；断线后 CLI 自动降级为直读 SQLite，恢复后重新接入队列。

所有解析与排版都在 Worker 中完成，主线程只处理输入、DOM overlay 与工具栏；没有跨线程的大对象拷贝。

- 稠密 + 稀疏互补
- RRF 不需要归一化
- 重排只处理前 20 条

| 指标 | 20 | 60 | 100 |
|---|---|---|---|
| nDCG | 0.412 | 0.438 | 0.431 |
| MRR | 0.381 | 0.402 | 0.399 |

```rust
fn score_60(rank: usize, k: f64) -> f64 {
    1.0 / (k + rank as f64)
}
```

![基准图 60](data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAA8AAAAIcCAIAAAC2P1AsAAASoElEQVR4nO3ce5Tf853H8c/8MpOc7cY1LHbrEhL3S0upu4rIBquEIFmJiBypRkgoYRSpFINVm7qt0lEEpW6pXVbXNa7FaXdru/QYqhrqtCSSkoQZmdk/fj3ZnJnJNC+1fobH46/ffM5nvt/3b37/PPM531/q5i9cUgAAgJVTqfUAAADQmwhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAjU1+rGW2y3e61uDQDAp8MLv3j847+pE2gAAAgIaAAACNTsEY5lanLwDgBA71Xbh4GdQAMAQEBAAwBAQEADAEBAQAMAQEBAAwBAQEADAEBAQAMAQEBAAwBAQEADAEBAQAMAQEBAAwBAQEADAEBAQAMAQEBAAwBAQEADAEBAQAMAQEBAAwBAQEADAEBAQAMAQEBAAwBAQEADAEBAQAMAQEBAAwBAQEADAEBAQAMAQEBAAwBAQEADAEBAQAMAQKC+1gN8SF/caZ9tttmio6MsWrS48dQTd/zSF1a0Ut0/5Cu7Hz121Mpc+Zprbzz2mDHLr7z08ivP/uy/Rh8+4kPMudNuw5954r4V/fihfVTX6eFSd8y+567Z9yxavPiUkybttstO77z7buOZ57399oI11li96dxvrtK/f9c9Tz717PRvX7TeeuuUUnb44nZTJh/7kUwIAPCJ0lsDuqGh4Ybmy0spL7a8fGrjjB/ffn0PK5FrmjsH9KBNBg7aZOBHNXmvMP/tBbPv/vcbrr38N6/OPeGkM+6ZfdP3rrnhSztsd/TYUT+44Zarm2d9Y8rXu+55a978CeOPHHXYwbUeHwDg/1Gvf4Rj8KCNf/+HN3te6WSn3Yafcfb5s26+7Y9/fGfaGTPGT5wyZvzxz/3y+VLKZVc2L168eMJxJy2/rfq6lNJ1/4jDj67eq7W1bfiBo15sefnIcV8/8JCx18+6dUV3/6dLrhhz9KQx449/7fU3ul6weq+Zl1099pjJBx827oGHHi2lvL1g4QknnXHUhMkTjjtp3vy3q9uqe7566FHVPdVf/Ob0pmEHHH7LbbOnnTFj3/0Pq47x0suvdJpq+bdWNW/+2weNHPfSy69Uf1ywYOGRow6tVCrrrbvOggULSylzHntq/+FDSyn7D99nzqNPdbvnzTffWnutAX/+MwMA6M166wn0Mk889czOO+3Q80onrW2t+w/fZ/ddv3zmty4YM3rkttts+cYbv5805bS7fnTdCZMmzLrptuar/nn5bct+8aJLrui0f9jQvR965PHRh494+tmf77Hbzj+89a6Tpxw3aJOBBx4ydtzYI7q99dZbbX7qycfffc9PLrj40tVXW63TBUspbW1ta6y+2qxrL5/72u+OmjB56JA9L7z4suHDhhyw39A7Z99z+ZXN0888pbWttbrnN6/OHT9xytAhe5ZS3m99/4iRB00+7ph99ht5y43fm3rCxFFjvjZu7BE3/fCOTlN1emttbW3fmDa9cdqJyw7aNx644cYDNyyl/OT+h/fea7dSyrx589casGYpZe21BsybN7/bPX94a96rc1+/9rqbV1tt1dNPPXGD9f/uQ32kAACfaL01oNva2o6aMPmDD5b++pVX/+3OG3tYqe4/56xpAzfaoPq6UqnsuvOOpZQnnnzmt3Nfqy4uXvLe0vb2PpX/O5Jftm2ZrvuHD9v7/Au/O/rwEQ/PefyA/fbdfNNB9973wMOPPvnuokXdjl1X6qqxO3zfIRd954qG+vquA7R3tB9y8AGllPU//7fvvrOolPLTp3/27emnlVIO+up++w7dq5TS0dFR3bPRhutX95RSKnWVrbbavE+l0tBQv/WWm1cqlffee7+UcspJkzpN1emtzTj/kgMPGNb1Xx2/nft683U3X998WQ8fxPJ76urqNt900Iyzp93/4Jyzz7nwuu9f2sMvAgD0Ur01oJc939z8g5vuuvveY48Z08NKJ/V96iuVSinlg6UfXHPlJf369W1vb//5fz63fD0vv22ZrvsHbrTBgoUL31206IVftZzVePLESacMG7rXmNGH3vKju7odu65SV+nTp/q6b9+Gtra2rgM0NDSsskr/P+2vqyulLG1f2tFRSil9KpXqt/e67qkuVq/Qr2+/5SefespZnaZa/q21trW2vPTrUsqhI/5h+VEXL15y8rSzzzuncc01Vi+lDBiw5lvz5v/N2mu9+da8AQPW7HbP2H8cue6665RShuy9x/QZF3X7FwAA6O16/TPQu+6y43P//XzPKyuy/Re2rT5A/NgTP726eVZ1sb2jvb29feX3D/nKHtc037jt1lvU1dX98vlfDf/7Ia3vt7a2tnV7haVLlz762FOllPvuf+jLO27f7QUrdZ0/lG233vLBRx4rpdx+579e8t2rut3Tg56n6tvQ9+br/+X1371x2x13L1vs6Og4/cxzxx81ettttqyu7LXHLvfe90Ap5d77Htxzj1263fOdmVc9MueJUspzz/3PpoM3WfkJAQB6kd56Ar3MwI02eLHl5eWTt+vKijSeeuLZMy685bbZ9X36zJh+WnVxh+23m3Ti6Vdd3s0Barf7hw/b+6CR467//qWllNGHjxg99rjNNxu06ir9W1vb+vZt2HDDz1/dPGvihLHVzf369vuPBx5pvu7mVVfpf+45ja3vt3a9YFennXLCmd9quvmWO1fp/9cXnnfWSv9t/qTrVJ02VCqViy/41qgxEzfbbNC2W29ZSrnrx/c+/uTTCxYuvPX22Z/7q89ddflFXzv2qMYzz7v/gTnV/8au2z1TJh97xlnnXX/jrf369uvh7QAA9Gp18xcuqcmNt9hu9+qLF37xeE0GAACgl6ptSfb6RzgAAODjJKABACAgoAEAICCgAQAgIKABACAgoAEAICCgAQAgIKABACAgoAEAICCgAQAgIKABACAgoAEAICCgAQAgIKABACAgoAEAICCgAQAgIKABACAgoAEAICCgAQAgIKABACAgoAEAICCgAQAgIKABACAgoAEAICCgAQAgIKABACAgoAEAICCgAQAgIKABACAgoAEAICCgAQAgIKABACAgoAEAICCgAQAgIKABACAgoAEAICCgAQAgIKABACAgoAEAICCgAQAgIKABACAgoAEAICCgAQAgIKABACAgoAEAICCgAQAgIKABACAgoAEAICCgAQAgIKABACAgoAEAICCgAQAgIKABACAgoAEAICCgAQAgIKABACAgoAEAICCgAQAgIKABACAgoAEAICCgAQAgIKABACAgoAEAICCgAQAgIKABACAgoAEAICCgAQAgUF/rAcoW2+1e6xEAAGBlOYEGAICAgAYAgEDd/IVLaj0DAAD0Gk6gAQAgIKABACAgoAEAICCgAQAgIKABACAgoAEAICCgAQAgIKABACAgoAEAICCgAQAgIKABACAgoAEAIFBf6wEA4NNsamNLbQeY2TS4tgPAp48TaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAjU13oAAD7rpja21HaAmU2DazsA0Ls4gQYAgICABgCAgIAGAICAgAYAgICABgCAgIAGAICAgAYAgICABgCAgIAGAICAgAYAgICABgCAgIAGAICAgAYAgICABgCAgIAGAICAgAYAgICABgCAgIAGAICAgAYAgICABgCAgIAGAICAgAYAgICABgCAgIAGAICAgAYAgICABgCAgIAGAICAgAYAgICABgCAgIAGAICAgAYAgICABgCAgIAGAICAgAYAgICABgCAgIAGAIBAfa0HAODPm9rYUtsBZjYNru0AAJ8cTqABACAgoAEAICCgAQAgIKABACAgoAEAICCgAQAgIKABACAgoAEAICCgAQAgIKABACAgoAEAICCgAQAgIKABACAgoAEAICCgAQAgIKABACAgoAEAICCgAQAgIKABACAgoAEAICCgAQAgIKABACAgoAEAICCgAQAgIKABACAgoAEAICCgAQAgIKABACAgoAEAICCgAQAgIKABACAgoAEAICCgAQAgIKABACAgoAEAICCgAQAgUF/rAQA+GlMbW2o7wMymwbUdAICPhxNoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACNTXegDg4zO1saW2A8xsGlzbAQDgL+cEGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAL1tR4APlmmNrbUdoCZTYNrOwAA0DMn0AAAEBDQAAAQENAAABDwDDQAwGeO7/z8JZxAAwBAQEADAEBAQAMAQEBAAwBAQEADAEBAQAMAQEBAAwBAQEADAEBAQAMAQEBAAwBAQEADAEBAQAMAQEBAAwBAQEADAEBAQAMAQEBAAwBAQEADAEBAQAMAQEBAAwBAQEADAEBAQAMAQEBAAwBAQEADAEBAQAMAQEBAAwBAQEADAEBAQAMAQEBAAwBAQEADAEBAQAMAQEBAAwBAQEADAECgvtYD0PtMbWyp7QAzmwbXdgAA4LPMCTQAAAQENAAABAQ0AAAEPAMNANAN3/lhRZxAAwBAQEADAEBAQAMAQEBAAwBAQEADAEBAQAMAQEBAAwBAQEADAEBAQAMAQEBAAwBAQEADAEBAQAMAQEBAAwBAQEADAEBAQAMAQEBAAwBAQEADAEBAQAMAQEBAAwBAQEADAEBAQAMAQEBAAwBAQEADAEBAQAMAQEBAAwBAQEADAEBAQAMAQEBAAwBAQEADAEBAQAMAQEBAAwBAQEADAECgvtYDfDpNbWyp7QAzmwbXdgAAgE8rJ9AAABAQ0AAAEBDQAAAQ8Aw0APAh+c4Pn01OoAEAICCgAQAgIKABACAgoAEAICCgAQAgIKABACAgoAEAICCgAQAgIKABACAgoAEAICCgAQAgIKABACAgoAEAICCgAQAgIKABACAgoAEAICCgAQAgIKABACAgoAEAICCgAQAgIKABACAgoAEAICCgAQAgIKABACAgoAEAICCgAQAgIKABACAgoAEAICCgAQAgIKABACAgoAEAICCgAQAgUF+rG09tbKnVratmNg2u7QAAAPRGdfMXLqn1DAAA0Gt4hAMAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAACAhoAAAICGgAAAgIaAAAC/wuzN58Z+uwyoQAAAABJRU5ErkJggg==)

补充说明：稠密向量检索擅长语义近似，但对专有名词与代码标识符的召回不稳定；稀疏检索（BM25）恰好互补。、倒数排名融合（RRF）以 1/(k+rank) 对各路结果加权求和，无需分数归一化，k 取 60 时在多数基准上表现稳健。、评测采用 nDCG@10 与 MRR 两个指标，黄金集为 20 条人工标注的单点定位题；重排阶段再以交叉编码器对前 20 条精排。、守护进程与 CLI 通过 Unix 域套接字通信；断线后 CLI 自动降级为直读 SQLite，恢复后重新接入队列。、所有解析与排版都在 Worker 中完成，主线程只处理输入、DOM overlay 与工具栏；没有跨线程的大对象拷贝。

补充说明：稠密向量检索擅长语义近似，但对专有名词与代码标识符的召回不稳定；稀疏检索（BM25）恰好互补。、倒数排名融合（RRF）以 1/(k+rank) 对各路结果加权求和，无需分数归一化，k 取 60 时在多数基准上表现稳健。、评测采用 nDCG@10 与 MRR 两个指标，黄金集为 20 条人工标注的单点定位题；重排阶段再以交叉编码器对前 20 条精排。、守护进程与 CLI 通过 Unix 域套接字通信；断线后 CLI 自动降级为直读 SQLite，恢复后重新接入队列。、所有解析与排版都在 Worker 中完成，主线程只处理输入、DOM overlay 与工具栏；没有跨线程的大对象拷贝。

补充说明：稠密向量检索擅长语义近似，但对专有名词与代码标识符的召回不稳定；稀疏检索（BM25）恰好互补。、倒数排名融合（RRF）以 1/(k+rank) 对各路结果加权求和，无需分数归一化，k 取 60 时在多数基准上表现稳健。、评测采用 nDCG@10 与 MRR 两个指标，黄金集为 20 条人工标注的单点定位题；重排阶段再以交叉编码器对前 20 条精排。、守护进程与 CLI 通过 Unix 域套接字通信；断线后 CLI 自动降级为直读 SQLite，恢复后重新接入队列。、所有解析与排版都在 Worker 中完成，主线程只处理输入、DOM overlay 与工具栏；没有跨线程的大对象拷贝。

补充说明：稠密向量检索擅长语义近似，但对专有名词与代码标识符的召回不稳定；稀疏检索（BM25）恰好互补。、倒数排名融合（RRF）以 1/(k+rank) 对各路结果加权求和，无需分数归一化，k 取 60 时在多数基准上表现稳健。、评测采用 nDCG@10 与 MRR 两个指标，黄金集为 20 条人工标注的单点定位题；重排阶段再以交叉编码器对前 20 条精排。、守护进程与 CLI 通过 Unix 域套接字通信；断线后 CLI 自动降级为直读 SQLite，恢复后重新接入队列。、所有解析与排版都在 Worker 中完成，主线程只处理输入、DOM overlay 与工具栏；没有跨线程的大对象拷贝。

补充说明：稠密向量检索擅长语义近似，但对专有名词与代码标识符的召回不稳定；稀疏检索（BM25）恰好互补。、倒数排名融合（RRF）以 1/(k+rank) 对各路结果加权求和，无需分数归一化，k 取 60 时在多数基准上表现稳健。、评测采用 nDCG@10 与 MRR 两个指标，黄金集为 20 条人工标注的单点定位题；重排阶段再以交叉编码器对前 20 条精排。、守护进程与 CLI 通过 Unix 域套接字通信；断线后 CLI 自动降级为直读 SQLite，恢复后重新接入队列。、所有解析与排版都在 Worker 中完成，主线程只处理输入、DOM overlay 与工具栏；没有跨线程的大对象拷贝。

补充说明：稠密向量检索擅长语义近似，但对专有名词与代码标识符的召回不稳定；稀疏检索（BM25）恰好互补。、倒数排名融合（RRF）以 1/(k+rank) 对各路结果加权求和，无需分数归一化，k 取 60 时在多数基准上表现稳健。、评测采用 nDCG@10 与 MRR 两个指标，黄金集为 20 条人工标注的单点定位题；重排阶段再以交叉编码器对前 20 条精排。、守护进程与 CLI 通过 Unix 域套接字通信；断线后 CLI 自动降级为直读 SQLite，恢复后重新接入队列。、所有解析与排版都在 Worker 中完成，主线程只处理输入、DOM overlay 与工具栏；没有跨线程的大对象拷贝。

补充说明：稠密向量检索擅长语义近似，但对专有名词与代码标识符的召回不稳定；稀疏检索（BM25）恰好互补。、倒数排名融合（RRF）以 1/(k+rank) 对各路结果加权求和，无需分数归一化，k 取 60 时在多数基准上表现稳健。、评测采用 nDCG@10 与 MRR 两个指标，黄金集为 20 条人工标注的单点定位题；重排阶段再以交叉编码器对前 20 条精排。、守护进程与 CLI 通过 Unix 域套接字通信；断线后 CLI 自动降级为直读 SQLite，恢复后重新接入队列。、所有解析与排版都在 Worker 中完成，主线程只处理输入、DOM overlay 与工具栏；没有跨线程的大对象拷贝。

补充说明：稠密向量检索擅长语义近似，但对专有名词与代码标识符的召回不稳定；稀疏检索（BM25）恰好互补。、倒数排名融合（RRF）以 1/(k+rank) 对各路结果加权求和，无需分数归一化，k 取 60 时在多数基准上表现稳健。、评测采用 nDCG@10 与 MRR 两个指标，黄金集为 20 条人工标注的单点定位题；重排阶段再以交叉编码器对前 20 条精排。、守护进程与 CLI 通过 Unix 域套接字通信；断线后 CLI 自动降级为直读 SQLite，恢复后重新接入队列。、所有解析与排版都在 Worker 中完成，主线程只处理输入、DOM overlay 与工具栏；没有跨线程的大对象拷贝。

补充说明：稠密向量检索擅长语义近似，但对专有名词与代码标识符的召回不稳定；稀疏检索（BM25）恰好互补。、倒数排名融合（RRF）以 1/(k+rank) 对各路结果加权求和，无需分数归一化，k 取 60 时在多数基准上表现稳健。、评测采用 nDCG@10 与 MRR 两个指标，黄金集为 20 条人工标注的单点定位题；重排阶段再以交叉编码器对前 20 条精排。、守护进程与 CLI 通过 Unix 域套接字通信；断线后 CLI 自动降级为直读 SQLite，恢复后重新接入队列。、所有解析与排版都在 Worker 中完成，主线程只处理输入、DOM overlay 与工具栏；没有跨线程的大对象拷贝。

补充说明：稠密向量检索擅长语义近似，但对专有名词与代码标识符的召回不稳定；稀疏检索（BM25）恰好互补。、倒数排名融合（RRF）以 1/(k+rank) 对各路结果加权求和，无需分数归一化，k 取 60 时在多数基准上表现稳健。、评测采用 nDCG@10 与 MRR 两个指标，黄金集为 20 条人工标注的单点定位题；重排阶段再以交叉编码器对前 20 条精排。、守护进程与 CLI 通过 Unix 域套接字通信；断线后 CLI 自动降级为直读 SQLite，恢复后重新接入队列。、所有解析与排版都在 Worker 中完成，主线程只处理输入、DOM overlay 与工具栏；没有跨线程的大对象拷贝。

补充说明：稠密向量检索擅长语义近似，但对专有名词与代码标识符的召回不稳定；稀疏检索（BM25）恰好互补。、倒数排名融合（RRF）以 1/(k+rank) 对各路结果加权求和，无需分数归一化，k 取 60 时在多数基准上表现稳健。、评测采用 nDCG@10 与 MRR 两个指标，黄金集为 20 条人工标注的单点定位题；重排阶段再以交叉编码器对前 20 条精排。、守护进程与 CLI 通过 Unix 域套接字通信；断线后 CLI 自动降级为直读 SQLite，恢复后重新接入队列。、所有解析与排版都在 Worker 中完成，主线程只处理输入、DOM overlay 与工具栏；没有跨线程的大对象拷贝。

补充说明：稠密向量检索擅长语义近似，但对专有名词与代码标识符的召回不稳定；稀疏检索（BM25）恰好互补。、倒数排名融合（RRF）以 1/(k+rank) 对各路结果加权求和，无需分数归一化，k 取 60 时在多数基准上表现稳健。、评测采用 nDCG@10 与 MRR 两个指标，黄金集为 20 条人工标注的单点定位题；重排阶段再以交叉编码器对前 20 条精排。、守护进程与 CLI 通过 Unix 域套接字通信；断线后 CLI 自动降级为直读 SQLite，恢复后重新接入队列。、所有解析与排版都在 Worker 中完成，主线程只处理输入、DOM overlay 与工具栏；没有跨线程的大对象拷贝。

补充说明：稠密向量检索擅长语义近似，但对专有名词与代码标识符的召回不稳定；稀疏检索（BM25）恰好互补。、倒数排名融合（RRF）以 1/(k+rank) 对各路结果加权求和，无需分数归一化，k 取 60 时在多数基准上表现稳健。、评测采用 nDCG@10 与 MRR 两个指标，黄金集为 20 条人工标注的单点定位题；重排阶段再以交叉编码器对前 20 条精排。、守护进程与 CLI 通过 Unix 域套接字通信；断线后 CLI 自动降级为直读 SQLite，恢复后重新接入队列。、所有解析与排版都在 Worker 中完成，主线程只处理输入、DOM overlay 与工具栏；没有跨线程的大对象拷贝。

补充说明：稠密向量检索擅长语义近似，但对专有名词与代码标识符的召回不稳定；稀疏检索（BM25）恰好互补。、倒数排名融合（RRF）以 1/(k+rank) 对各路结果加权求和，无需分数归一化，k 取 60 时在多数基准上表现稳健。、评测采用 nDCG@10 与 MRR 两个指标，黄金集为 20 条人工标注的单点定位题；重排阶段再以交叉编码器对前 20 条精排。、守护进程与 CLI 通过 Unix 域套接字通信；断线后 CLI 自动降级为直读 SQLite，恢复后重新接入队列。、所有解析与排版都在 Worker 中完成，主线程只处理输入、DOM overlay 与工具栏；没有跨线程的大对象拷贝。

补充说明：稠密向量检索擅长语义近似，但对专有名词与代码标识符的召回不稳定；稀疏检索（BM25）恰好互补。、倒数排名融合（RRF）以 1/(k+rank) 对各路结果加权求和，无需分数归一化，k 取 60 时在多数基准上表现稳健。、评测采用 nDCG@10 与 MRR 两个指标，黄金集为 20 条人工标注的单点定位题；重排阶段再以交叉编码器对前 20 条精排。、守护进程与 CLI 通过 Unix 域套接字通信；断线后 CLI 自动降级为直读 SQLite，恢复后重新接入队列。、所有解析与排版都在 Worker 中完成，主线程只处理输入、DOM overlay 与工具栏；没有跨线程的大对象拷贝。

补充说明：稠密向量检索擅长语义近似，但对专有名词与代码标识符的召回不稳定；稀疏检索（BM25）恰好互补。、倒数排名融合（RRF）以 1/(k+rank) 对各路结果加权求和，无需分数归一化，k 取 60 时在多数基准上表现稳健。、评测采用 nDCG@10 与 MRR 两个指标，黄金集为 20 条人工标注的单点定位题；重排阶段再以交叉编码器对前 20 条精排。、守护进程与 CLI 通过 Unix 域套接字通信；断线后 CLI 自动降级为直读 SQLite，恢复后重新接入队列。、所有解析与排版都在 Worker 中完成，主线程只处理输入、DOM overlay 与工具栏；没有跨线程的大对象拷贝。

补充说明：稠密向量检索擅长语义近似，但对专有名词与代码标识符的召回不稳定；稀疏检索（BM25）恰好互补。、倒数排名融合（RRF）以 1/(k+rank) 对各路结果加权求和，无需分数归一化，k 取 60 时在多数基准上表现稳健。、评测采用 nDCG@10 与 MRR 两个指标，黄金集为 20 条人工标注的单点定位题；重排阶段再以交叉编码器对前 20 条精排。、守护进程与 CLI 通过 Unix 域套接字通信；断线后 CLI 自动降级为直读 SQLite，恢复后重新接入队列。、所有解析与排版都在 Worker 中完成，主线程只处理输入、DOM overlay 与工具栏；没有跨线程的大对象拷贝。

补充说明：稠密向量检索擅长语义近似，但对专有名词与代码标识符的召回不稳定；稀疏检索（BM25）恰好互补。、倒数排名融合（RRF）以 1/(k+rank) 对各路结果加权求和，无需分数归一化，k 取 60 时在多数基准上表现稳健。、评测采用 nDCG@10 与 MRR 两个指标，黄金集为 20 条人工标注的单点定位题；重排阶段再以交叉编码器对前 20 条精排。、守护进程与 CLI 通过 Unix 域套接字通信；断线后 CLI 自动降级为直读 SQLite，恢复后重新接入队列。、所有解析与排版都在 Worker 中完成，主线程只处理输入、DOM overlay 与工具栏；没有跨线程的大对象拷贝。

补充说明：稠密向量检索擅长语义近似，但对专有名词与代码标识符的召回不稳定；稀疏检索（BM25）恰好互补。、倒数排名融合（RRF）以 1/(k+rank) 对各路结果加权求和，无需分数归一化，k 取 60 时在多数基准上表现稳健。、评测采用 nDCG@10 与 MRR 两个指标，黄金集为 20 条人工标注的单点定位题；重排阶段再以交叉编码器对前 20 条精排。、守护进程与 CLI 通过 Unix 域套接字通信；断线后 CLI 自动降级为直读 SQLite，恢复后重新接入队列。、所有解析与排版都在 Worker 中完成，主线程只处理输入、DOM overlay 与工具栏；没有跨线程的大对象拷贝。

补充说明：稠密向量检索擅长语义近似，但对专有名词与代码标识符的召回不稳定；稀疏检索（BM25）恰好互补。、倒数排名融合（RRF）以 1/(k+rank) 对各路结果加权求和，无需分数归一化，k 取 60 时在多数基准上表现稳健。、评测采用 nDCG@10 与 MRR 两个指标，黄金集为 20 条人工标注的单点定位题；重排阶段再以交叉编码器对前 20 条精排。、守护进程与 CLI 通过 Unix 域套接字通信；断线后 CLI 自动降级为直读 SQLite，恢复后重新接入队列。、所有解析与排版都在 Worker 中完成，主线程只处理输入、DOM overlay 与工具栏；没有跨线程的大对象拷贝。

补充说明：稠密向量检索擅长语义近似，但对专有名词与代码标识符的召回不稳定；稀疏检索（BM25）恰好互补。、倒数排名融合（RRF）以 1/(k+rank) 对各路结果加权求和，无需分数归一化，k 取 60 时在多数基准上表现稳健。、评测采用 nDCG@10 与 MRR 两个指标，黄金集为 20 条人工标注的单点定位题；重排阶段再以交叉编码器对前 20 条精排。、守护进程与 CLI 通过 Unix 域套接字通信；断线后 CLI 自动降级为直读 SQLite，恢复后重新接入队列。、所有解析与排版都在 Worker 中完成，主线程只处理输入、DOM overlay 与工具栏；没有跨线程的大对象拷贝。

补充说明：稠密向量检索擅长语义近似，但对专有名词与代码标识符的召回不稳定；稀疏检索（BM25）恰好互补。、倒数排名融合（RRF）以 1/(k+rank) 对各路结果加权求和，无需分数归一化，k 取 60 时在多数基准上表现稳健。、评测采用 nDCG@10 与 MRR 两个指标，黄金集为 20 条人工标注的单点定位题；重排阶段再以交叉编码器对前 20 条精排。、守护进程与 CLI 通过 Unix 域套接字通信；断线后 CLI 自动降级为直读 SQLite，恢复后重新接入队列。、所有解析与排版都在 Worker 中完成，主线程只处理输入、DOM overlay 与工具栏；没有跨线程的大对象拷贝。

补充说明：稠密向量检索擅长语义近似，但对专有名词与代码标识符的召回不稳定；稀疏检索（BM25）恰好互补。、倒数排名融合（RRF）以 1/(k+rank) 对各路结果加权求和，无需分数归一化，k 取 60 时在多数基准上表现稳健。、评测采用 nDCG@10 与 MRR 两个指标，黄金集为 20 条人工标注的单点定位题；重排阶段再以交叉编码器对前 20 条精排。、守护进程与 CLI 通过 Unix 域套接字通信；断线后 CLI 自动降级为直读 SQLite，恢复后重新接入队列。、所有解析与排版都在 Worker 中完成，主线程只处理输入、DOM overlay 与工具栏；没有跨线程的大对象拷贝。

补充说明：稠密向量检索擅长语义近似，但对专有名词与代码标识符的召回不稳定；稀疏检索（BM25）恰好互补。、倒数排名融合（RRF）以 1/(k+rank) 对各路结果加权求和，无需分数归一化，k 取 60 时在多数基准上表现稳健。、评测采用 nDCG@10 与 MRR 两个指标，黄金集为 20 条人工标注的单点定位题；重排阶段再以交叉编码器对前 20 条精排。、守护进程与 CLI 通过 Unix 域套接字通信；断线后 CLI 自动降级为直读 SQLite，恢复后重新接入队列。、所有解析与排版都在 Worker 中完成，主线程只处理输入、DOM overlay 与工具栏；没有跨线程的大对象拷贝。

补充说明：稠密向量检索擅长语义近似，但对专有名词与代码标识符的召回不稳定；稀疏检索（BM25）恰好互补。、倒数排名融合（RRF）以 1/(k+rank) 对各路结果加权求和，无需分数归一化，k 取 60 时在多数基准上表现稳健。、评测采用 nDCG@10 与 MRR 两个指标，黄金集为 20 条人工标注的单点定位题；重排阶段再以交叉编码器对前 20 条精排。、守护进程与 CLI 通过 Unix 域套接字通信；断线后 CLI 自动降级为直读 SQLite，恢复后重新接入队列。、所有解析与排版都在 Worker 中完成，主线程只处理输入、DOM overlay 与工具栏；没有跨线程的大对象拷贝。

补充说明：稠密向量检索擅长语义近似，但对专有名词与代码标识符的召回不稳定；稀疏检索（BM25）恰好互补。、倒数排名融合（RRF）以 1/(k+rank) 对各路结果加权求和，无需分数归一化，k 取 60 时在多数基准上表现稳健。、评测采用 nDCG@10 与 MRR 两个指标，黄金集为 20 条人工标注的单点定位题；重排阶段再以交叉编码器对前 20 条精排。、守护进程与 CLI 通过 Unix 域套接字通信；断线后 CLI 自动降级为直读 SQLite，恢复后重新接入队列。、所有解析与排版都在 Worker 中完成，主线程只处理输入、DOM overlay 与工具栏；没有跨线程的大对象拷贝。

补充说明：稠密向量检索擅长语义近似，但对专有名词与代码标识符的召回不稳定；稀疏检索（BM25）恰好互补。、倒数排名融合（RRF）以 1/(k+rank) 对各路结果加权求和，无需分数归一化，k 取 60 时在多数基准上表现稳健。、评测采用 nDCG@10 与 MRR 两个指标，黄金集为 20 条人工标注的单点定位题；重排阶段再以交叉编码器对前 20 条精排。、守护进程与 CLI 通过 Unix 域套接字通信；断线后 CLI 自动降级为直读 SQLite，恢复后重新接入队列。、所有解析与排版都在 Worker 中完成，主线程只处理输入、DOM overlay 与工具栏；没有跨线程的大对象拷贝。

补充说明：稠密向量检索擅长语义近似，但对专有名词与代码标识符的召回不稳定；稀疏检索（BM25）恰好互补。、倒数排名融合（RRF）以 1/(k+rank) 对各路结果加权求和，无需分数归一化，k 取 60 时在多数基准上表现稳健。、评测采用 nDCG@10 与 MRR 两个指标，黄金集为 20 条人工标注的单点定位题；重排阶段再以交叉编码器对前 20 条精排。、守护进程与 CLI 通过 Unix 域套接字通信；断线后 CLI 自动降级为直读 SQLite，恢复后重新接入队列。、所有解析与排版都在 Worker 中完成，主线程只处理输入、DOM overlay 与工具栏；没有跨线程的大对象拷贝。

补充说明：稠密向量检索擅长语义近似，但对专有名词与代码标识符的召回不稳定；稀疏检索（BM25）恰好互补。、倒数排名融合（RRF）以 1/(k+rank) 对各路结果加权求和，无需分数归一化，k 取 60 时在多数基准上表现稳健。、评测采用 nDCG@10 与 MRR 两个指标，黄金集为 20 条人工标注的单点定位题；重排阶段再以交叉编码器对前 20 条精排。、守护进程与 CLI 通过 Unix 域套接字通信；断线后 CLI 自动降级为直读 SQLite，恢复后重新接入队列。、所有解析与排版都在 Worker 中完成，主线程只处理输入、DOM overlay 与工具栏；没有跨线程的大对象拷贝。

补充说明：稠密向量检索擅长语义近似，但对专有名词与代码标识符的召回不稳定；稀疏检索（BM25）恰好互补。、倒数排名融合（RRF）以 1/(k+rank) 对各路结果加权求和，无需分数归一化，k 取 60 时在多数基准上表现稳健。、评测采用 nDCG@10 与 MRR 两个指标，黄金集为 20 条人工标注的单点定位题；重排阶段再以交叉编码器对前 20 条精排。、守护进程与 CLI 通过 Unix 域套接字通信；断线后 CLI 自动降级为直读 SQLite，恢复后重新接入队列。、所有解析与排版都在 Worker 中完成，主线程只处理输入、DOM overlay 与工具栏；没有跨线程的大对象拷贝。

补充说明：稠密向量检索擅长语义近似，但对专有名词与代码标识符的召回不稳定；稀疏检索（BM25）恰好互补。、倒数排名融合（RRF）以 1/(k+rank) 对各路结果加权求和，无需分数归一化，k 取 60 时在多数基准上表现稳健。、评测采用 nDCG@10 与 MRR 两个指标，黄金集为 20 条人工标注的单点定位题；重排阶段再以交叉编码器对前 20 条精排。、守护进程与 CLI 通过 Unix 域套接字通信；断线后 CLI 自动降级为直读 SQLite，恢复后重新接入队列。、所有解析与排版都在 Worker 中完成，主线程只处理输入、DOM overlay 与工具栏；没有跨线程的大对象拷贝。

补充说明：稠密向量检索擅长语义近似，但对专有名词与代码标识符的召回不稳定；稀疏检索（BM25）恰好互补。、倒数排名融合（RRF）以 1/(k+rank) 对各路结果加权求和，无需分数归一化，k 取 60 时在多数基准上表现稳健。、评测采用 nDCG@10 与 MRR 两个指标，黄金集为 20 条人工标注的单点定位题；重排阶段再以交叉编码器对前 20 条精排。、守护进程与 CLI 通过 Unix 域套接字通信；断线后 CLI 自动降级为直读 SQLite，恢复后重新接入队列。、所有解析与排版都在 Worker 中完成，主线程只处理输入、DOM overlay 与工具栏；没有跨线程的大对象拷贝。

补充说明：稠密向量检索擅长语义近似，但对专有名词与代码标识符的召回不稳定；稀疏检索（BM25）恰好互补。、倒数排名融合（RRF）以 1/(k+rank) 对各路结果加权求和，无需分数归一化，k 取 60 时在多数基准上表现稳健。、评测采用 nDCG@10 与 MRR 两个指标，黄金集为 20 条人工标注的单点定位题；重排阶段再以交叉编码器对前 20 条精排。、守护进程与 CLI 通过 Unix 域套接字通信；断线后 CLI 自动降级为直读 SQLite，恢复后重新接入队列。、所有解析与排版都在 Worker 中完成，主线程只处理输入、DOM overlay 与工具栏；没有跨线程的大对象拷贝。

补充说明：稠密向量检索擅长语义近似，但对专有名词与代码标识符的召回不稳定；稀疏检索（BM25）恰好互补。、倒数排名融合（RRF）以 1/(k+rank) 对各路结果加权求和，无需分数归一化，k 取 60 时在多数基准上表现稳健。、评测采用 nDCG@10 与 MRR 两个指标，黄金集为 20 条人工标注的单点定位题；重排阶段再以交叉编码器对前 20 条精排。、守护进程与 CLI 通过 Unix 域套接字通信；断线后 CLI 自动降级为直读 SQLite，恢复后重新接入队列。、所有解析与排版都在 Worker 中完成，主线程只处理输入、DOM overlay 与工具栏；没有跨线程的大对象拷贝。

补充说明：稠密向量检索擅长语义近似，但对专有名词与代码标识符的召回不稳定；稀疏检索（BM25）恰好互补。、倒数排名融合（RRF）以 1/(k+rank) 对各路结果加权求和，无需分数归一化，k 取 60 时在多数基准上表现稳健。、评测采用 nDCG@10 与 MRR 两个指标，黄金集为 20 条人工标注的单点定位题；重排阶段再以交叉编码器对前 20 条精排。、守护进程与 CLI 通过 Unix 域套接字通信；断线后 CLI 自动降级为直读 SQLite，恢复后重新接入队列。、所有解析与排版都在 Worker 中完成，主线程只处理输入、DOM overlay 与工具栏；没有跨线程的大对象拷贝。

补充说明：稠密向量检索擅长语义近似，但对专有名词与代码标识符的召回不稳定；稀疏检索（BM25）恰好互补。、倒数排名融合（RRF）以 1/(k+rank) 对各路结果加权求和，无需分数归一化，k 取 60 时在多数基准上表现稳健。、评测采用 nDCG@10 与 MRR 两个指标，黄金集为 20 条人工标注的单点定位题；重排阶段再以交叉编码器对前 20 条精排。、守护进程与 CLI 通过 Unix 域套接字通信；断线后 CLI 自动降级为直读 SQLite，恢复后重新接入队列。、所有解析与排版都在 Worker 中完成，主线程只处理输入、DOM overlay 与工具栏；没有跨线程的大对象拷贝。

补充说明：稠密向量检索擅长语义近似，但对专有名词与代码标识符的召回不稳定；稀疏检索（BM25）恰好互补。、倒数排名融合（RRF）以 1/(k+rank) 对各路结果加权求和，无需分数归一化，k 取 60 时在多数基准上表现稳健。、评测采用 nDCG@10 与 MRR 两个指标，黄金集为 20 条人工标注的单点定位题；重排阶段再以交叉编码器对前 20 条精排。、守护进程与 CLI 通过 Unix 域套接字通信；断线后 CLI 自动降级为直读 SQLite，恢复后重新接入队列。、所有解析与排版都在 Worker 中完成，主线程只处理输入、DOM overlay 与工具栏；没有跨线程的大对象拷贝。

补充说明：稠密向量检索擅长语义近似，但对专有名词与代码标识符的召回不稳定；稀疏检索（BM25）恰好互补。、倒数排名融合（RRF）以 1/(k+rank) 对各路结果加权求和，无需分数归一化，k 取 60 时在多数基准上表现稳健。、评测采用 nDCG@10 与 MRR 两个指标，黄金集为 20 条人工标注的单点定位题；重排阶段再以交叉编码器对前 20 条精排。、守护进程与 CLI 通过 Unix 域套接字通信；断线后 CLI 自动降级为直读 SQLite，恢复后重新接入队列。、所有解析与排版都在 Worker 中完成，主线程只处理输入、DOM overlay 与工具栏；没有跨线程的大对象拷贝。

补充说明：稠密向量检索擅长语义近似，但对专有名词与代码标识符的召回不稳定；稀疏检索（BM25）恰好互补。、倒数排名融合（RRF）以 1/(k+rank) 对各路结果加权求和，无需分数归一化，k 取 60 时在多数基准上表现稳健。、评测采用 nDCG@10 与 MRR 两个指标，黄金集为 20 条人工标注的单点定位题；重排阶段再以交叉编码器对前 20 条精排。、守护进程与 CLI 通过 Unix 域套接字通信；断线后 CLI 自动降级为直读 SQLite，恢复后重新接入队列。、所有解析与排版都在 Worker 中完成，主线程只处理输入、DOM overlay 与工具栏；没有跨线程的大对象拷贝。

补充说明：稠密向量检索擅长语义近似，但对专有名词与代码标识符的召回不稳定；稀疏检索（BM25）恰好互补。、倒数排名融合（RRF）以 1/(k+rank) 对各路结果加权求和，无需分数归一化，k 取 60 时在多数基准上表现稳健。、评测采用 nDCG@10 与 MRR 两个指标，黄金集为 20 条人工标注的单点定位题；重排阶段再以交叉编码器对前 20 条精排。、守护进程与 CLI 通过 Unix 域套接字通信；断线后 CLI 自动降级为直读 SQLite，恢复后重新接入队列。、所有解析与排版都在 Worker 中完成，主线程只处理输入、DOM overlay 与工具栏；没有跨线程的大对象拷贝。

补充说明：稠密向量检索擅长语义近似，但对专有名词与代码标识符的召回不稳定；稀疏检索（BM25）恰好互补。、倒数排名融合（RRF）以 1/(k+rank) 对各路结果加权求和，无需分数归一化，k 取 60 时在多数基准上表现稳健。、评测采用 nDCG@10 与 MRR 两个指标，黄金集为 20 条人工标注的单点定位题；重排阶段再以交叉编码器对前 20 条精排。、守护进程与 CLI 通过 Unix 域套接字通信；断线后 CLI 自动降级为直读 SQLite，恢复后重新接入队列。、所有解析与排版都在 Worker 中完成，主线程只处理输入、DOM overlay 与工具栏；没有跨线程的大对象拷贝。

补充说明：稠密向量检索擅长语义近似，但对专有名词与代码标识符的召回不稳定；稀疏检索（BM25）恰好互补。、倒数排名融合（RRF）以 1/(k+rank) 对各路结果加权求和，无需分数归一化，k 取 60 时在多数基准上表现稳健。、评测采用 nDCG@10 与 MRR 两个指标，黄金集为 20 条人工标注的单点定位题；重排阶段再以交叉编码器对前 20 条精排。、守护进程与 CLI 通过 Unix 域套接字通信；断线后 CLI 自动降级为直读 SQLite，恢复后重新接入队列。、所有解析与排版都在 Worker 中完成，主线程只处理输入、DOM overlay 与工具栏；没有跨线程的大对象拷贝。

补充说明：稠密向量检索擅长语义近似，但对专有名词与代码标识符的召回不稳定；稀疏检索（BM25）恰好互补。、倒数排名融合（RRF）以 1/(k+rank) 对各路结果加权求和，无需分数归一化，k 取 60 时在多数基准上表现稳健。、评测采用 nDCG@10 与 MRR 两个指标，黄金集为 20 条人工标注的单点定位题；重排阶段再以交叉编码器对前 20 条精排。、守护进程与 CLI 通过 Unix 域套接字通信；断线后 CLI 自动降级为直读 SQLite，恢复后重新接入队列。、所有解析与排版都在 Worker 中完成，主线程只处理输入、DOM overlay 与工具栏；没有跨线程的大对象拷贝。

补充说明：稠密向量检索擅长语义近似，但对专有名词与代码标识符的召回不稳定；稀疏检索（BM25）恰好互补。、倒数排名融合（RRF）以 1/(k+rank) 对各路结果加权求和，无需分数归一化，k 取 60 时在多数基准上表现稳健。、评测采用 nDCG@10 与 MRR 两个指标，黄金集为 20 条人工标注的单点定位题；重排阶段再以交叉编码器对前 20 条精排。、守护进程与 CLI 通过 Unix 域套接字通信；断线后 CLI 自动降级为直读 SQLite，恢复后重新接入队列。、所有解析与排版都在 Worker 中完成，主线程只处理输入、DOM overlay 与工具栏；没有跨线程的大对象拷贝。

补充说明：稠密向量检索擅长语义近似，但对专有名词与代码标识符的召回不稳定；稀疏检索（BM25）恰好互补。、倒数排名融合（RRF）以 1/(k+rank) 对各路结果加权求和，无需分数归一化，k 取 60 时在多数基准上表现稳健。、评测采用 nDCG@10 与 MRR 两个指标，黄金集为 20 条人工标注的单点定位题；重排阶段再以交叉编码器对前 20 条精排。、守护进程与 CLI 通过 Unix 域套接字通信；断线后 CLI 自动降级为直读 SQLite，恢复后重新接入队列。、所有解析与排版都在 Worker 中完成，主线程只处理输入、DOM overlay 与工具栏；没有跨线程的大对象拷贝。

补充说明：稠密向量检索擅长语义近似，但对专有名词与代码标识符的召回不稳定；稀疏检索（BM25）恰好互补。、倒数排名融合（RRF）以 1/(k+rank) 对各路结果加权求和，无需分数归一化，k 取 60 时在多数基准上表现稳健。、评测采用 nDCG@10 与 MRR 两个指标，黄金集为 20 条人工标注的单点定位题；重排阶段再以交叉编码器对前 20 条精排。、守护进程与 CLI 通过 Unix 域套接字通信；断线后 CLI 自动降级为直读 SQLite，恢复后重新接入队列。、所有解析与排版都在 Worker 中完成，主线程只处理输入、DOM overlay 与工具栏；没有跨线程的大对象拷贝。

补充说明：稠密向量检索擅长语义近似，但对专有名词与代码标识符的召回不稳定；稀疏检索（BM25）恰好互补。、倒数排名融合（RRF）以 1/(k+rank) 对各路结果加权求和，无需分数归一化，k 取 60 时在多数基准上表现稳健。、评测采用 nDCG@10 与 MRR 两个指标，黄金集为 20 条人工标注的单点定位题；重排阶段再以交叉编码器对前 20 条精排。、守护进程与 CLI 通过 Unix 域套接字通信；断线后 CLI 自动降级为直读 SQLite，恢复后重新接入队列。、所有解析与排版都在 Worker 中完成，主线程只处理输入、DOM overlay 与工具栏；没有跨线程的大对象拷贝。

补充说明：稠密向量检索擅长语义近似，但对专有名词与代码标识符的召回不稳定；稀疏检索（BM25）恰好互补。、倒数排名融合（RRF）以 1/(k+rank) 对各路结果加权求和，无需分数归一化，k 取 60 时在多数基准上表现稳健。、评测采用 nDCG@10 与 MRR 两个指标，黄金集为 20 条人工标注的单点定位题；重排阶段再以交叉编码器对前 20 条精排。、守护进程与 CLI 通过 Unix 域套接字通信；断线后 CLI 自动降级为直读 SQLite，恢复后重新接入队列。、所有解析与排版都在 Worker 中完成，主线程只处理输入、DOM overlay 与工具栏；没有跨线程的大对象拷贝。

补充说明：稠密向量检索擅长语义近似，但对专有名词与代码标识符的召回不稳定；稀疏检索（BM25）恰好互补。、倒数排名融合（RRF）以 1/(k+rank) 对各路结果加权求和，无需分数归一化，k 取 60 时在多数基准上表现稳健。、评测采用 nDCG@10 与 MRR 两个指标，黄金集为 20 条人工标注的单点定位题；重排阶段再以交叉编码器对前 20 条精排。、守护进程与 CLI 通过 Unix 域套接字通信；断线后 CLI 自动降级为直读 SQLite，恢复后重新接入队列。、所有解析与排版都在 Worker 中完成，主线程只处理输入、DOM overlay 与工具栏；没有跨线程的大对象拷贝。

补充说明：稠密向量检索擅长语义近似，但对专有名词与代码标识符的召回不稳定；稀疏检索（BM25）恰好互补。、倒数排名融合（RRF）以 1/(k+rank) 对各路结果加权求和，无需分数归一化，k 取 60 时在多数基准上表现稳健。、评测采用 nDCG@10 与 MRR 两个指标，黄金集为 20 条人工标注的单点定位题；重排阶段再以交叉编码器对前 20 条精排。、守护进程与 CLI 通过 Unix 域套接字通信；断线后 CLI 自动降级为直读 SQLite，恢复后重新接入队列。、所有解析与排版都在 Worker 中完成，主线程只处理输入、DOM overlay 与工具栏；没有跨线程的大对象拷贝。

补充说明：稠密向量检索擅长语义近似，但对专有名词与代码标识符的召回不稳定；稀疏检索（BM25）恰好互补。、倒数排名融合（RRF）以 1/(k+rank) 对各路结果加权求和，无需分数归一化，k 取 60 时在多数基准上表现稳健。、评测采用 nDCG@10 与 MRR 两个指标，黄金集为 20 条人工标注的单点定位题；重排阶段再以交叉编码器对前 20 条精排。、守护进程与 CLI 通过 Unix 域套接字通信；断线后 CLI 自动降级为直读 SQLite，恢复后重新接入队列。、所有解析与排版都在 Worker 中完成，主线程只处理输入、DOM overlay 与工具栏；没有跨线程的大对象拷贝。

补充说明：稠密向量检索擅长语义近似，但对专有名词与代码标识符的召回不稳定；稀疏检索（BM25）恰好互补。、倒数排名融合（RRF）以 1/(k+rank) 对各路结果加权求和，无需分数归一化，k 取 60 时在多数基准上表现稳健。、评测采用 nDCG@10 与 MRR 两个指标，黄金集为 20 条人工标注的单点定位题；重排阶段再以交叉编码器对前 20 条精排。、守护进程与 CLI 通过 Unix 域套接字通信；断线后 CLI 自动降级为直读 SQLite，恢复后重新接入队列。、所有解析与排版都在 Worker 中完成，主线程只处理输入、DOM overlay 与工具栏；没有跨线程的大对象拷贝。

补充说明：稠密向量检索擅长语义近似，但对专有名词与代码标识符的召回不稳定；稀疏检索（BM25）恰好互补。、倒数排名融合（RRF）以 1/(k+rank) 对各路结果加权求和，无需分数归一化，k 取 60 时在多数基准上表现稳健。、评测采用 nDCG@10 与 MRR 两个指标，黄金集为 20 条人工标注的单点定位题；重排阶段再以交叉编码器对前 20 条精排。、守护进程与 CLI 通过 Unix 域套接字通信；断线后 CLI 自动降级为直读 SQLite，恢复后重新接入队列。、所有解析与排版都在 Worker 中完成，主线程只处理输入、DOM overlay 与工具栏；没有跨线程的大对象拷贝。

补充说明：稠密向量检索擅长语义近似，但对专有名词与代码标识符的召回不稳定；稀疏检索（BM25）恰好互补。、倒数排名融合（RRF）以 1/(k+rank) 对各路结果加权求和，无需分数归一化，k 取 60 时在多数基准上表现稳健。、评测采用 nDCG@10 与 MRR 两个指标，黄金集为 20 条人工标注的单点定位题；重排阶段再以交叉编码器对前 20 条精排。、守护进程与 CLI 通过 Unix 域套接字通信；断线后 CLI 自动降级为直读 SQLite，恢复后重新接入队列。、所有解析与排版都在 Worker 中完成，主线程只处理输入、DOM overlay 与工具栏；没有跨线程的大对象拷贝。

补充说明：稠密向量检索擅长语义近似，但对专有名词与代码标识符的召回不稳定；稀疏检索（BM25）恰好互补。、倒数排名融合（RRF）以 1/(k+rank) 对各路结果加权求和，无需分数归一化，k 取 60 时在多数基准上表现稳健。、评测采用 nDCG@10 与 MRR 两个指标，黄金集为 20 条人工标注的单点定位题；重排阶段再以交叉编码器对前 20 条精排。、守护进程与 CLI 通过 Unix 域套接字通信；断线后 CLI 自动降级为直读 SQLite，恢复后重新接入队列。、所有解析与排版都在 Worker 中完成，主线程只处理输入、DOM overlay 与工具栏；没有跨线程的大对象拷贝。

补充说明：稠密向量检索擅长语义近似，但对专有名词与代码标识符的召回不稳定；稀疏检索（BM25）恰好互补。、倒数排名融合（RRF）以 1/(k+rank) 对各路结果加权求和，无需分数归一化，k 取 60 时在多数基准上表现稳健。、评测采用 nDCG@10 与 MRR 两个指标，黄金集为 20 条人工标注的单点定位题；重排阶段再以交叉编码器对前 20 条精排。、守护进程与 CLI 通过 Unix 域套接字通信；断线后 CLI 自动降级为直读 SQLite，恢复后重新接入队列。、所有解析与排版都在 Worker 中完成，主线程只处理输入、DOM overlay 与工具栏；没有跨线程的大对象拷贝。

补充说明：稠密向量检索擅长语义近似，但对专有名词与代码标识符的召回不稳定；稀疏检索（BM25）恰好互补。、倒数排名融合（RRF）以 1/(k+rank) 对各路结果加权求和，无需分数归一化，k 取 60 时在多数基准上表现稳健。、评测采用 nDCG@10 与 MRR 两个指标，黄金集为 20 条人工标注的单点定位题；重排阶段再以交叉编码器对前 20 条精排。、守护进程与 CLI 通过 Unix 域套接字通信；断线后 CLI 自动降级为直读 SQLite，恢复后重新接入队列。、所有解析与排版都在 Worker 中完成，主线程只处理输入、DOM overlay 与工具栏；没有跨线程的大对象拷贝。

补充说明：稠密向量检索擅长语义近似，但对专有名词与代码标识符的召回不稳定；稀疏检索（BM25）恰好互补。、倒数排名融合（RRF）以 1/(k+rank) 对各路结果加权求和，无需分数归一化，k 取 60 时在多数基准上表现稳健。、评测采用 nDCG@10 与 MRR 两个指标，黄金集为 20 条人工标注的单点定位题；重排阶段再以交叉编码器对前 20 条精排。、守护进程与 CLI 通过 Unix 域套接字通信；断线后 CLI 自动降级为直读 SQLite，恢复后重新接入队列。、所有解析与排版都在 Worker 中完成，主线程只处理输入、DOM overlay 与工具栏；没有跨线程的大对象拷贝。

补充说明：稠密向量检索擅长语义近似，但对专有名词与代码标识符的召回不稳定；稀疏检索（BM25）恰好互补。、倒数排名融合（RRF）以 1/(k+rank) 对各路结果加权求和，无需分数归一化，k 取 60 时在多数基准上表现稳健。、评测采用 nDCG@10 与 MRR 两个指标，黄金集为 20 条人工标注的单点定位题；重排阶段再以交叉编码器对前 20 条精排。、守护进程与 CLI 通过 Unix 域套接字通信；断线后 CLI 自动降级为直读 SQLite，恢复后重新接入队列。、所有解析与排版都在 Worker 中完成，主线程只处理输入、DOM overlay 与工具栏；没有跨线程的大对象拷贝。

补充说明：稠密向量检索擅长语义近似，但对专有名词与代码标识符的召回不稳定；稀疏检索（BM25）恰好互补。、倒数排名融合（RRF）以 1/(k+rank) 对各路结果加权求和，无需分数归一化，k 取 60 时在多数基准上表现稳健。、评测采用 nDCG@10 与 MRR 两个指标，黄金集为 20 条人工标注的单点定位题；重排阶段再以交叉编码器对前 20 条精排。、守护进程与 CLI 通过 Unix 域套接字通信；断线后 CLI 自动降级为直读 SQLite，恢复后重新接入队列。、所有解析与排版都在 Worker 中完成，主线程只处理输入、DOM overlay 与工具栏；没有跨线程的大对象拷贝。

补充说明：稠密向量检索擅长语义近似，但对专有名词与代码标识符的召回不稳定；稀疏检索（BM25）恰好互补。、倒数排名融合（RRF）以 1/(k+rank) 对各路结果加权求和，无需分数归一化，k 取 60 时在多数基准上表现稳健。、评测采用 nDCG@10 与 MRR 两个指标，黄金集为 20 条人工标注的单点定位题；重排阶段再以交叉编码器对前 20 条精排。、守护进程与 CLI 通过 Unix 域套接字通信；断线后 CLI 自动降级为直读 SQLite，恢复后重新接入队列。、所有解析与排版都在 Worker 中完成，主线程只处理输入、DOM overlay 与工具栏；没有跨线程的大对象拷贝。

补充说明：稠密向量检索擅长语义近似，但对专有名词与代码标识符的召回不稳定；稀疏检索（BM25）恰好互补。、倒数排名融合（RRF）以 1/(k+rank) 对各路结果加权求和，无需分数归一化，k 取 60 时在多数基准上表现稳健。、评测采用 nDCG@10 与 MRR 两个指标，黄金集为 20 条人工标注的单点定位题；重排阶段再以交叉编码器对前 20 条精排。、守护进程与 CLI 通过 Unix 域套接字通信；断线后 CLI 自动降级为直读 SQLite，恢复后重新接入队列。、所有解析与排版都在 Worker 中完成，主线程只处理输入、DOM overlay 与工具栏；没有跨线程的大对象拷贝。

补充说明：稠密向量检索擅长语义近似，但对专有名词与代码标识符的召回不稳定；稀疏检索（BM25）恰好互补。、倒数排名融合（RRF）以 1/(k+rank) 对各路结果加权求和，无需分数归一化，k 取 60 时在多数基准上表现稳健。、评测采用 nDCG@10 与 MRR 两个指标，黄金集为 20 条人工标注的单点定位题；重排阶段再以交叉编码器对前 20 条精排。、守护进程与 CLI 通过 Unix 域套接字通信；断线后 CLI 自动降级为直读 SQLite，恢复后重新接入队列。、所有解析与排版都在 Worker 中完成，主线程只处理输入、DOM overlay 与工具栏；没有跨线程的大对象拷贝。

补充说明：稠密向量检索擅长语义近似，但对专有名词与代码标识符的召回不稳定；稀疏检索（BM25）恰好互补。、倒数排名融合（RRF）以 1/(k+rank) 对各路结果加权求和，无需分数归一化，k 取 60 时在多数基准上表现稳健。、评测采用 nDCG@10 与 MRR 两个指标，黄金集为 20 条人工标注的单点定位题；重排阶段再以交叉编码器对前 20 条精排。、守护进程与 CLI 通过 Unix 域套接字通信；断线后 CLI 自动降级为直读 SQLite，恢复后重新接入队列。、所有解析与排版都在 Worker 中完成，主线程只处理输入、DOM overlay 与工具栏；没有跨线程的大对象拷贝。

补充说明：稠密向量检索擅长语义近似，但对专有名词与代码标识符的召回不稳定；稀疏检索（BM25）恰好互补。、倒数排名融合（RRF）以 1/(k+rank) 对各路结果加权求和，无需分数归一化，k 取 60 时在多数基准上表现稳健。、评测采用 nDCG@10 与 MRR 两个指标，黄金集为 20 条人工标注的单点定位题；重排阶段再以交叉编码器对前 20 条精排。、守护进程与 CLI 通过 Unix 域套接字通信；断线后 CLI 自动降级为直读 SQLite，恢复后重新接入队列。、所有解析与排版都在 Worker 中完成，主线程只处理输入、DOM overlay 与工具栏；没有跨线程的大对象拷贝。

补充说明：稠密向量检索擅长语义近似，但对专有名词与代码标识符的召回不稳定；稀疏检索（BM25）恰好互补。、倒数排名融合（RRF）以 1/(k+rank) 对各路结果加权求和，无需分数归一化，k 取 60 时在多数基准上表现稳健。、评测采用 nDCG@10 与 MRR 两个指标，黄金集为 20 条人工标注的单点定位题；重排阶段再以交叉编码器对前 20 条精排。、守护进程与 CLI 通过 Unix 域套接字通信；断线后 CLI 自动降级为直读 SQLite，恢复后重新接入队列。、所有解析与排版都在 Worker 中完成，主线程只处理输入、DOM overlay 与工具栏；没有跨线程的大对象拷贝。

补充说明：稠密向量检索擅长语义近似，但对专有名词与代码标识符的召回不稳定；稀疏检索（BM25）恰好互补。、倒数排名融合（RRF）以 1/(k+rank) 对各路结果加权求和，无需分数归一化，k 取 60 时在多数基准上表现稳健。、评测采用 nDCG@10 与 MRR 两个指标，黄金集为 20 条人工标注的单点定位题；重排阶段再以交叉编码器对前 20 条精排。、守护进程与 CLI 通过 Unix 域套接字通信；断线后 CLI 自动降级为直读 SQLite，恢复后重新接入队列。、所有解析与排版都在 Worker 中完成，主线程只处理输入、DOM overlay 与工具栏；没有跨线程的大对象拷贝。

补充说明：稠密向量检索擅长语义近似，但对专有名词与代码标识符的召回不稳定；稀疏检索（BM25）恰好互补。、倒数排名融合（RRF）以 1/(k+rank) 对各路结果加权求和，无需分数归一化，k 取 60 时在多数基准上表现稳健。、评测采用 nDCG@10 与 MRR 两个指标，黄金集为 20 条人工标注的单点定位题；重排阶段再以交叉编码器对前 20 条精排。、守护进程与 CLI 通过 Unix 域套接字通信；断线后 CLI 自动降级为直读 SQLite，恢复后重新接入队列。、所有解析与排版都在 Worker 中完成，主线程只处理输入、DOM overlay 与工具栏；没有跨线程的大对象拷贝。

补充说明：稠密向量检索擅长语义近似，但对专有名词与代码标识符的召回不稳定；稀疏检索（BM25）恰好互补。、倒数排名融合（RRF）以 1/(k+rank) 对各路结果加权求和，无需分数归一化，k 取 60 时在多数基准上表现稳健。、评测采用 nDCG@10 与 MRR 两个指标，黄金集为 20 条人工标注的单点定位题；重排阶段再以交叉编码器对前 20 条精排。、守护进程与 CLI 通过 Unix 域套接字通信；断线后 CLI 自动降级为直读 SQLite，恢复后重新接入队列。、所有解析与排版都在 Worker 中完成，主线程只处理输入、DOM overlay 与工具栏；没有跨线程的大对象拷贝。

补充说明：稠密向量检索擅长语义近似，但对专有名词与代码标识符的召回不稳定；稀疏检索（BM25）恰好互补。、倒数排名融合（RRF）以 1/(k+rank) 对各路结果加权求和，无需分数归一化，k 取 60 时在多数基准上表现稳健。、评测采用 nDCG@10 与 MRR 两个指标，黄金集为 20 条人工标注的单点定位题；重排阶段再以交叉编码器对前 20 条精排。、守护进程与 CLI 通过 Unix 域套接字通信；断线后 CLI 自动降级为直读 SQLite，恢复后重新接入队列。、所有解析与排版都在 Worker 中完成，主线程只处理输入、DOM overlay 与工具栏；没有跨线程的大对象拷贝。

补充说明：稠密向量检索擅长语义近似，但对专有名词与代码标识符的召回不稳定；稀疏检索（BM25）恰好互补。、倒数排名融合（RRF）以 1/(k+rank) 对各路结果加权求和，无需分数归一化，k 取 60 时在多数基准上表现稳健。、评测采用 nDCG@10 与 MRR 两个指标，黄金集为 20 条人工标注的单点定位题；重排阶段再以交叉编码器对前 20 条精排。、守护进程与 CLI 通过 Unix 域套接字通信；断线后 CLI 自动降级为直读 SQLite，恢复后重新接入队列。、所有解析与排版都在 Worker 中完成，主线程只处理输入、DOM overlay 与工具栏；没有跨线程的大对象拷贝。

补充说明：稠密向量检索擅长语义近似，但对专有名词与代码标识符的召回不稳定；稀疏检索（BM25）恰好互补。、倒数排名融合（RRF）以 1/(k+rank) 对各路结果加权求和，无需分数归一化，k 取 60 时在多数基准上表现稳健。、评测采用 nDCG@10 与 MRR 两个指标，黄金集为 20 条人工标注的单点定位题；重排阶段再以交叉编码器对前 20 条精排。、守护进程与 CLI 通过 Unix 域套接字通信；断线后 CLI 自动降级为直读 SQLite，恢复后重新接入队列。、所有解析与排版都在 Worker 中完成，主线程只处理输入、DOM overlay 与工具栏；没有跨线程的大对象拷贝。

补充说明：稠密向量检索擅长语义近似，但对专有名词与代码标识符的召回不稳定；稀疏检索（BM25）恰好互补。、倒数排名融合（RRF）以 1/(k+rank) 对各路结果加权求和，无需分数归一化，k 取 60 时在多数基准上表现稳健。、评测采用 nDCG@10 与 MRR 两个指标，黄金集为 20 条人工标注的单点定位题；重排阶段再以交叉编码器对前 20 条精排。、守护进程与 CLI 通过 Unix 域套接字通信；断线后 CLI 自动降级为直读 SQLite，恢复后重新接入队列。、所有解析与排版都在 Worker 中完成，主线程只处理输入、DOM overlay 与工具栏；没有跨线程的大对象拷贝。

补充说明：稠密向量检索擅长语义近似，但对专有名词与代码标识符的召回不稳定；稀疏检索（BM25）恰好互补。、倒数排名融合（RRF）以 1/(k+rank) 对各路结果加权求和，无需分数归一化，k 取 60 时在多数基准上表现稳健。、评测采用 nDCG@10 与 MRR 两个指标，黄金集为 20 条人工标注的单点定位题；重排阶段再以交叉编码器对前 20 条精排。、守护进程与 CLI 通过 Unix 域套接字通信；断线后 CLI 自动降级为直读 SQLite，恢复后重新接入队列。、所有解析与排版都在 Worker 中完成，主线程只处理输入、DOM overlay 与工具栏；没有跨线程的大对象拷贝。

补充说明：稠密向量检索擅长语义近似，但对专有名词与代码标识符的召回不稳定；稀疏检索（BM25）恰好互补。、倒数排名融合（RRF）以 1/(k+rank) 对各路结果加权求和，无需分数归一化，k 取 60 时在多数基准上表现稳健。、评测采用 nDCG@10 与 MRR 两个指标，黄金集为 20 条人工标注的单点定位题；重排阶段再以交叉编码器对前 20 条精排。、守护进程与 CLI 通过 Unix 域套接字通信；断线后 CLI 自动降级为直读 SQLite，恢复后重新接入队列。、所有解析与排版都在 Worker 中完成，主线程只处理输入、DOM overlay 与工具栏；没有跨线程的大对象拷贝。

补充说明：稠密向量检索擅长语义近似，但对专有名词与代码标识符的召回不稳定；稀疏检索（BM25）恰好互补。、倒数排名融合（RRF）以 1/(k+rank) 对各路结果加权求和，无需分数归一化，k 取 60 时在多数基准上表现稳健。、评测采用 nDCG@10 与 MRR 两个指标，黄金集为 20 条人工标注的单点定位题；重排阶段再以交叉编码器对前 20 条精排。、守护进程与 CLI 通过 Unix 域套接字通信；断线后 CLI 自动降级为直读 SQLite，恢复后重新接入队列。、所有解析与排版都在 Worker 中完成，主线程只处理输入、DOM overlay 与工具栏；没有跨线程的大对象拷贝。

补充说明：稠密向量检索擅长语义近似，但对专有名词与代码标识符的召回不稳定；稀疏检索（BM25）恰好互补。、倒数排名融合（RRF）以 1/(k+rank) 对各路结果加权求和，无需分数归一化，k 取 60 时在多数基准上表现稳健。、评测采用 nDCG@10 与 MRR 两个指标，黄金集为 20 条人工标注的单点定位题；重排阶段再以交叉编码器对前 20 条精排。、守护进程与 CLI 通过 Unix 域套接字通信；断线后 CLI 自动降级为直读 SQLite，恢复后重新接入队列。、所有解析与排版都在 Worker 中完成，主线程只处理输入、DOM overlay 与工具栏；没有跨线程的大对象拷贝。

补充说明：稠密向量检索擅长语义近似，但对专有名词与代码标识符的召回不稳定；稀疏检索（BM25）恰好互补。、倒数排名融合（RRF）以 1/(k+rank) 对各路结果加权求和，无需分数归一化，k 取 60 时在多数基准上表现稳健。、评测采用 nDCG@10 与 MRR 两个指标，黄金集为 20 条人工标注的单点定位题；重排阶段再以交叉编码器对前 20 条精排。、守护进程与 CLI 通过 Unix 域套接字通信；断线后 CLI 自动降级为直读 SQLite，恢复后重新接入队列。、所有解析与排版都在 Worker 中完成，主线程只处理输入、DOM overlay 与工具栏；没有跨线程的大对象拷贝。

补充说明：稠密向量检索擅长语义近似，但对专有名词与代码标识符的召回不稳定；稀疏检索（BM25）恰好互补。、倒数排名融合（RRF）以 1/(k+rank) 对各路结果加权求和，无需分数归一化，k 取 60 时在多数基准上表现稳健。、评测采用 nDCG@10 与 MRR 两个指标，黄金集为 20 条人工标注的单点定位题；重排阶段再以交叉编码器对前 20 条精排。、守护进程与 CLI 通过 Unix 域套接字通信；断线后 CLI 自动降级为直读 SQLite，恢复后重新接入队列。、所有解析与排版都在 Worker 中完成，主线程只处理输入、DOM overlay 与工具栏；没有跨线程的大对象拷贝。

补充说明：稠密向量检索擅长语义近似，但对专有名词与代码标识符的召回不稳定；稀疏检索（BM25）恰好互补。、倒数排名融合（RRF）以 1/(k+rank) 对各路结果加权求和，无需分数归一化，k 取 60 时在多数基准上表现稳健。、评测采用 nDCG@10 与 MRR 两个指标，黄金集为 20 条人工标注的单点定位题；重排阶段再以交叉编码器对前 20 条精排。、守护进程与 CLI 通过 Unix 域套接字通信；断线后 CLI 自动降级为直读 SQLite，恢复后重新接入队列。、所有解析与排版都在 Worker 中完成，主线程只处理输入、DOM overlay 与工具栏；没有跨线程的大对象拷贝。

补充说明：稠密向量检索擅长语义近似，但对专有名词与代码标识符的召回不稳定；稀疏检索（BM25）恰好互补。、倒数排名融合（RRF）以 1/(k+rank) 对各路结果加权求和，无需分数归一化，k 取 60 时在多数基准上表现稳健。、评测采用 nDCG@10 与 MRR 两个指标，黄金集为 20 条人工标注的单点定位题；重排阶段再以交叉编码器对前 20 条精排。、守护进程与 CLI 通过 Unix 域套接字通信；断线后 CLI 自动降级为直读 SQLite，恢复后重新接入队列。、所有解析与排版都在 Worker 中完成，主线程只处理输入、DOM overlay 与工具栏；没有跨线程的大对象拷贝。

补充说明：稠密向量检索擅长语义近似，但对专有名词与代码标识符的召回不稳定；稀疏检索（BM25）恰好互补。、倒数排名融合（RRF）以 1/(k+rank) 对各路结果加权求和，无需分数归一化，k 取 60 时在多数基准上表现稳健。、评测采用 nDCG@10 与 MRR 两个指标，黄金集为 20 条人工标注的单点定位题；重排阶段再以交叉编码器对前 20 条精排。、守护进程与 CLI 通过 Unix 域套接字通信；断线后 CLI 自动降级为直读 SQLite，恢复后重新接入队列。、所有解析与排版都在 Worker 中完成，主线程只处理输入、DOM overlay 与工具栏；没有跨线程的大对象拷贝。

补充说明：稠密向量检索擅长语义近似，但对专有名词与代码标识符的召回不稳定；稀疏检索（BM25）恰好互补。、倒数排名融合（RRF）以 1/(k+rank) 对各路结果加权求和，无需分数归一化，k 取 60 时在多数基准上表现稳健。、评测采用 nDCG@10 与 MRR 两个指标，黄金集为 20 条人工标注的单点定位题；重排阶段再以交叉编码器对前 20 条精排。、守护进程与 CLI 通过 Unix 域套接字通信；断线后 CLI 自动降级为直读 SQLite，恢复后重新接入队列。、所有解析与排版都在 Worker 中完成，主线程只处理输入、DOM overlay 与工具栏；没有跨线程的大对象拷贝。

补充说明：稠密向量检索擅长语义近似，但对专有名词与代码标识符的召回不稳定；稀疏检索（BM25）恰好互补。、倒数排名融合（RRF）以 1/(k+rank) 对各路结果加权求和，无需分数归一化，k 取 60 时在多数基准上表现稳健。、评测采用 nDCG@10 与 MRR 两个指标，黄金集为 20 条人工标注的单点定位题；重排阶段再以交叉编码器对前 20 条精排。、守护进程与 CLI 通过 Unix 域套接字通信；断线后 CLI 自动降级为直读 SQLite，恢复后重新接入队列。、所有解析与排版都在 Worker 中完成，主线程只处理输入、DOM overlay 与工具栏；没有跨线程的大对象拷贝。

补充说明：稠密向量检索擅长语义近似，但对专有名词与代码标识符的召回不稳定；稀疏检索（BM25）恰好互补。、倒数排名融合（RRF）以 1/(k+rank) 对各路结果加权求和，无需分数归一化，k 取 60 时在多数基准上表现稳健。、评测采用 nDCG@10 与 MRR 两个指标，黄金集为 20 条人工标注的单点定位题；重排阶段再以交叉编码器对前 20 条精排。、守护进程与 CLI 通过 Unix 域套接字通信；断线后 CLI 自动降级为直读 SQLite，恢复后重新接入队列。、所有解析与排版都在 Worker 中完成，主线程只处理输入、DOM overlay 与工具栏；没有跨线程的大对象拷贝。

补充说明：稠密向量检索擅长语义近似，但对专有名词与代码标识符的召回不稳定；稀疏检索（BM25）恰好互补。、倒数排名融合（RRF）以 1/(k+rank) 对各路结果加权求和，无需分数归一化，k 取 60 时在多数基准上表现稳健。、评测采用 nDCG@10 与 MRR 两个指标，黄金集为 20 条人工标注的单点定位题；重排阶段再以交叉编码器对前 20 条精排。、守护进程与 CLI 通过 Unix 域套接字通信；断线后 CLI 自动降级为直读 SQLite，恢复后重新接入队列。、所有解析与排版都在 Worker 中完成，主线程只处理输入、DOM overlay 与工具栏；没有跨线程的大对象拷贝。

补充说明：稠密向量检索擅长语义近似，但对专有名词与代码标识符的召回不稳定；稀疏检索（BM25）恰好互补。、倒数排名融合（RRF）以 1/(k+rank) 对各路结果加权求和，无需分数归一化，k 取 60 时在多数基准上表现稳健。、评测采用 nDCG@10 与 MRR 两个指标，黄金集为 20 条人工标注的单点定位题；重排阶段再以交叉编码器对前 20 条精排。、守护进程与 CLI 通过 Unix 域套接字通信；断线后 CLI 自动降级为直读 SQLite，恢复后重新接入队列。、所有解析与排版都在 Worker 中完成，主线程只处理输入、DOM overlay 与工具栏；没有跨线程的大对象拷贝。

补充说明：稠密向量检索擅长语义近似，但对专有名词与代码标识符的召回不稳定；稀疏检索（BM25）恰好互补。、倒数排名融合（RRF）以 1/(k+rank) 对各路结果加权求和，无需分数归一化，k 取 60 时在多数基准上表现稳健。、评测采用 nDCG@10 与 MRR 两个指标，黄金集为 20 条人工标注的单点定位题；重排阶段再以交叉编码器对前 20 条精排。、守护进程与 CLI 通过 Unix 域套接字通信；断线后 CLI 自动降级为直读 SQLite，恢复后重新接入队列。、所有解析与排版都在 Worker 中完成，主线程只处理输入、DOM overlay 与工具栏；没有跨线程的大对象拷贝。

补充说明：稠密向量检索擅长语义近似，但对专有名词与代码标识符的召回不稳定；稀疏检索（BM25）恰好互补。、倒数排名融合（RRF）以 1/(k+rank) 对各路结果加权求和，无需分数归一化，k 取 60 时在多数基准上表现稳健。、评测采用 nDCG@10 与 MRR 两个指标，黄金集为 20 条人工标注的单点定位题；重排阶段再以交叉编码器对前 20 条精排。、守护进程与 CLI 通过 Unix 域套接字通信；断线后 CLI 自动降级为直读 SQLite，恢复后重新接入队列。、所有解析与排版都在 Worker 中完成，主线程只处理输入、DOM overlay 与工具栏；没有跨线程的大对象拷贝。

补充说明：稠密向量检索擅长语义近似，但对专有名词与代码标识符的召回不稳定；稀疏检索（BM25）恰好互补。、倒数排名融合（RRF）以 1/(k+rank) 对各路结果加权求和，无需分数归一化，k 取 60 时在多数基准上表现稳健。、评测采用 nDCG@10 与 MRR 两个指标，黄金集为 20 条人工标注的单点定位题；重排阶段再以交叉编码器对前 20 条精排。、守护进程与 CLI 通过 Unix 域套接字通信；断线后 CLI 自动降级为直读 SQLite，恢复后重新接入队列。、所有解析与排版都在 Worker 中完成，主线程只处理输入、DOM overlay 与工具栏；没有跨线程的大对象拷贝。

补充说明：稠密向量检索擅长语义近似，但对专有名词与代码标识符的召回不稳定；稀疏检索（BM25）恰好互补。、倒数排名融合（RRF）以 1/(k+rank) 对各路结果加权求和，无需分数归一化，k 取 60 时在多数基准上表现稳健。、评测采用 nDCG@10 与 MRR 两个指标，黄金集为 20 条人工标注的单点定位题；重排阶段再以交叉编码器对前 20 条精排。、守护进程与 CLI 通过 Unix 域套接字通信；断线后 CLI 自动降级为直读 SQLite，恢复后重新接入队列。、所有解析与排版都在 Worker 中完成，主线程只处理输入、DOM overlay 与工具栏；没有跨线程的大对象拷贝。

补充说明：稠密向量检索擅长语义近似，但对专有名词与代码标识符的召回不稳定；稀疏检索（BM25）恰好互补。、倒数排名融合（RRF）以 1/(k+rank) 对各路结果加权求和，无需分数归一化，k 取 60 时在多数基准上表现稳健。、评测采用 nDCG@10 与 MRR 两个指标，黄金集为 20 条人工标注的单点定位题；重排阶段再以交叉编码器对前 20 条精排。、守护进程与 CLI 通过 Unix 域套接字通信；断线后 CLI 自动降级为直读 SQLite，恢复后重新接入队列。、所有解析与排版都在 Worker 中完成，主线程只处理输入、DOM overlay 与工具栏；没有跨线程的大对象拷贝。

补充说明：稠密向量检索擅长语义近似，但对专有名词与代码标识符的召回不稳定；稀疏检索（BM25）恰好互补。、倒数排名融合（RRF）以 1/(k+rank) 对各路结果加权求和，无需分数归一化，k 取 60 时在多数基准上表现稳健。、评测采用 nDCG@10 与 MRR 两个指标，黄金集为 20 条人工标注的单点定位题；重排阶段再以交叉编码器对前 20 条精排。、守护进程与 CLI 通过 Unix 域套接字通信；断线后 CLI 自动降级为直读 SQLite，恢复后重新接入队列。、所有解析与排版都在 Worker 中完成，主线程只处理输入、DOM overlay 与工具栏；没有跨线程的大对象拷贝。

补充说明：稠密向量检索擅长语义近似，但对专有名词与代码标识符的召回不稳定；稀疏检索（BM25）恰好互补。、倒数排名融合（RRF）以 1/(k+rank) 对各路结果加权求和，无需分数归一化，k 取 60 时在多数基准上表现稳健。、评测采用 nDCG@10 与 MRR 两个指标，黄金集为 20 条人工标注的单点定位题；重排阶段再以交叉编码器对前 20 条精排。、守护进程与 CLI 通过 Unix 域套接字通信；断线后 CLI 自动降级为直读 SQLite，恢复后重新接入队列。、所有解析与排版都在 Worker 中完成，主线程只处理输入、DOM overlay 与工具栏；没有跨线程的大对象拷贝。

补充说明：稠密向量检索擅长语义近似，但对专有名词与代码标识符的召回不稳定；稀疏检索（BM25）恰好互补。、倒数排名融合（RRF）以 1/(k+rank) 对各路结果加权求和，无需分数归一化，k 取 60 时在多数基准上表现稳健。、评测采用 nDCG@10 与 MRR 两个指标，黄金集为 20 条人工标注的单点定位题；重排阶段再以交叉编码器对前 20 条精排。、守护进程与 CLI 通过 Unix 域套接字通信；断线后 CLI 自动降级为直读 SQLite，恢复后重新接入队列。、所有解析与排版都在 Worker 中完成，主线程只处理输入、DOM overlay 与工具栏；没有跨线程的大对象拷贝。

补充说明：稠密向量检索擅长语义近似，但对专有名词与代码标识符的召回不稳定；稀疏检索（BM25）恰好互补。、倒数排名融合（RRF）以 1/(k+rank) 对各路结果加权求和，无需分数归一化，k 取 60 时在多数基准上表现稳健。、评测采用 nDCG@10 与 MRR 两个指标，黄金集为 20 条人工标注的单点定位题；重排阶段再以交叉编码器对前 20 条精排。、守护进程与 CLI 通过 Unix 域套接字通信；断线后 CLI 自动降级为直读 SQLite，恢复后重新接入队列。、所有解析与排版都在 Worker 中完成，主线程只处理输入、DOM overlay 与工具栏；没有跨线程的大对象拷贝。

补充说明：稠密向量检索擅长语义近似，但对专有名词与代码标识符的召回不稳定；稀疏检索（BM25）恰好互补。、倒数排名融合（RRF）以 1/(k+rank) 对各路结果加权求和，无需分数归一化，k 取 60 时在多数基准上表现稳健。、评测采用 nDCG@10 与 MRR 两个指标，黄金集为 20 条人工标注的单点定位题；重排阶段再以交叉编码器对前 20 条精排。、守护进程与 CLI 通过 Unix 域套接字通信；断线后 CLI 自动降级为直读 SQLite，恢复后重新接入队列。、所有解析与排版都在 Worker 中完成，主线程只处理输入、DOM overlay 与工具栏；没有跨线程的大对象拷贝。

补充说明：稠密向量检索擅长语义近似，但对专有名词与代码标识符的召回不稳定；稀疏检索（BM25）恰好互补。、倒数排名融合（RRF）以 1/(k+rank) 对各路结果加权求和，无需分数归一化，k 取 60 时在多数基准上表现稳健。、评测采用 nDCG@10 与 MRR 两个指标，黄金集为 20 条人工标注的单点定位题；重排阶段再以交叉编码器对前 20 条精排。、守护进程与 CLI 通过 Unix 域套接字通信；断线后 CLI 自动降级为直读 SQLite，恢复后重新接入队列。、所有解析与排版都在 Worker 中完成，主线程只处理输入、DOM overlay 与工具栏；没有跨线程的大对象拷贝。

补充说明：稠密向量检索擅长语义近似，但对专有名词与代码标识符的召回不稳定；稀疏检索（BM25）恰好互补。、倒数排名融合（RRF）以 1/(k+rank) 对各路结果加权求和，无需分数归一化，k 取 60 时在多数基准上表现稳健。、评测采用 nDCG@10 与 MRR 两个指标，黄金集为 20 条人工标注的单点定位题；重排阶段再以交叉编码器对前 20 条精排。、守护进程与 CLI 通过 Unix 域套接字通信；断线后 CLI 自动降级为直读 SQLite，恢复后重新接入队列。、所有解析与排版都在 Worker 中完成，主线程只处理输入、DOM overlay 与工具栏；没有跨线程的大对象拷贝。

补充说明：稠密向量检索擅长语义近似，但对专有名词与代码标识符的召回不稳定；稀疏检索（BM25）恰好互补。、倒数排名融合（RRF）以 1/(k+rank) 对各路结果加权求和，无需分数归一化，k 取 60 时在多数基准上表现稳健。、评测采用 nDCG@10 与 MRR 两个指标，黄金集为 20 条人工标注的单点定位题；重排阶段再以交叉编码器对前 20 条精排。、守护进程与 CLI 通过 Unix 域套接字通信；断线后 CLI 自动降级为直读 SQLite，恢复后重新接入队列。、所有解析与排版都在 Worker 中完成，主线程只处理输入、DOM overlay 与工具栏；没有跨线程的大对象拷贝。

补充说明：稠密向量检索擅长语义近似，但对专有名词与代码标识符的召回不稳定；稀疏检索（BM25）恰好互补。、倒数排名融合（RRF）以 1/(k+rank) 对各路结果加权求和，无需分数归一化，k 取 60 时在多数基准上表现稳健。、评测采用 nDCG@10 与 MRR 两个指标，黄金集为 20 条人工标注的单点定位题；重排阶段再以交叉编码器对前 20 条精排。、守护进程与 CLI 通过 Unix 域套接字通信；断线后 CLI 自动降级为直读 SQLite，恢复后重新接入队列。、所有解析与排版都在 Worker 中完成，主线程只处理输入、DOM overlay 与工具栏；没有跨线程的大对象拷贝。

补充说明：稠密向量检索擅长语义近似，但对专有名词与代码标识符的召回不稳定；稀疏检索（BM25）恰好互补。、倒数排名融合（RRF）以 1/(k+rank) 对各路结果加权求和，无需分数归一化，k 取 60 时在多数基准上表现稳健。、评测采用 nDCG@10 与 MRR 两个指标，黄金集为 20 条人工标注的单点定位题；重排阶段再以交叉编码器对前 20 条精排。、守护进程与 CLI 通过 Unix 域套接字通信；断线后 CLI 自动降级为直读 SQLite，恢复后重新接入队列。、所有解析与排版都在 Worker 中完成，主线程只处理输入、DOM overlay 与工具栏；没有跨线程的大对象拷贝。

补充说明：稠密向量检索擅长语义近似，但对专有名词与代码标识符的召回不稳定；稀疏检索（BM25）恰好互补。、倒数排名融合（RRF）以 1/(k+rank) 对各路结果加权求和，无需分数归一化，k 取 60 时在多数基准上表现稳健。、评测采用 nDCG@10 与 MRR 两个指标，黄金集为 20 条人工标注的单点定位题；重排阶段再以交叉编码器对前 20 条精排。、守护进程与 CLI 通过 Unix 域套接字通信；断线后 CLI 自动降级为直读 SQLite，恢复后重新接入队列。、所有解析与排版都在 Worker 中完成，主线程只处理输入、DOM overlay 与工具栏；没有跨线程的大对象拷贝。

补充说明：稠密向量检索擅长语义近似，但对专有名词与代码标识符的召回不稳定；稀疏检索（BM25）恰好互补。、倒数排名融合（RRF）以 1/(k+rank) 对各路结果加权求和，无需分数归一化，k 取 60 时在多数基准上表现稳健。、评测采用 nDCG@10 与 MRR 两个指标，黄金集为 20 条人工标注的单点定位题；重排阶段再以交叉编码器对前 20 条精排。、守护进程与 CLI 通过 Unix 域套接字通信；断线后 CLI 自动降级为直读 SQLite，恢复后重新接入队列。、所有解析与排版都在 Worker 中完成，主线程只处理输入、DOM overlay 与工具栏；没有跨线程的大对象拷贝。

补充说明：稠密向量检索擅长语义近似，但对专有名词与代码标识符的召回不稳定；稀疏检索（BM25）恰好互补。、倒数排名融合（RRF）以 1/(k+rank) 对各路结果加权求和，无需分数归一化，k 取 60 时在多数基准上表现稳健。、评测采用 nDCG@10 与 MRR 两个指标，黄金集为 20 条人工标注的单点定位题；重排阶段再以交叉编码器对前 20 条精排。、守护进程与 CLI 通过 Unix 域套接字通信；断线后 CLI 自动降级为直读 SQLite，恢复后重新接入队列。、所有解析与排版都在 Worker 中完成，主线程只处理输入、DOM overlay 与工具栏；没有跨线程的大对象拷贝。

补充说明：稠密向量检索擅长语义近似，但对专有名词与代码标识符的召回不稳定；稀疏检索（BM25）恰好互补。、倒数排名融合（RRF）以 1/(k+rank) 对各路结果加权求和，无需分数归一化，k 取 60 时在多数基准上表现稳健。、评测采用 nDCG@10 与 MRR 两个指标，黄金集为 20 条人工标注的单点定位题；重排阶段再以交叉编码器对前 20 条精排。、守护进程与 CLI 通过 Unix 域套接字通信；断线后 CLI 自动降级为直读 SQLite，恢复后重新接入队列。、所有解析与排版都在 Worker 中完成，主线程只处理输入、DOM overlay 与工具栏；没有跨线程的大对象拷贝。

补充说明：稠密向量检索擅长语义近似，但对专有名词与代码标识符的召回不稳定；稀疏检索（BM25）恰好互补。、倒数排名融合（RRF）以 1/(k+rank) 对各路结果加权求和，无需分数归一化，k 取 60 时在多数基准上表现稳健。、评测采用 nDCG@10 与 MRR 两个指标，黄金集为 20 条人工标注的单点定位题；重排阶段再以交叉编码器对前 20 条精排。、守护进程与 CLI 通过 Unix 域套接字通信；断线后 CLI 自动降级为直读 SQLite，恢复后重新接入队列。、所有解析与排版都在 Worker 中完成，主线程只处理输入、DOM overlay 与工具栏；没有跨线程的大对象拷贝。

补充说明：稠密向量检索擅长语义近似，但对专有名词与代码标识符的召回不稳定；稀疏检索（BM25）恰好互补。、倒数排名融合（RRF）以 1/(k+rank) 对各路结果加权求和，无需分数归一化，k 取 60 时在多数基准上表现稳健。、评测采用 nDCG@10 与 MRR 两个指标，黄金集为 20 条人工标注的单点定位题；重排阶段再以交叉编码器对前 20 条精排。、守护进程与 CLI 通过 Unix 域套接字通信；断线后 CLI 自动降级为直读 SQLite，恢复后重新接入队列。、所有解析与排版都在 Worker 中完成，主线程只处理输入、DOM overlay 与工具栏；没有跨线程的大对象拷贝。

补充说明：稠密向量检索擅长语义近似，但对专有名词与代码标识符的召回不稳定；稀疏检索（BM25）恰好互补。、倒数排名融合（RRF）以 1/(k+rank) 对各路结果加权求和，无需分数归一化，k 取 60 时在多数基准上表现稳健。、评测采用 nDCG@10 与 MRR 两个指标，黄金集为 20 条人工标注的单点定位题；重排阶段再以交叉编码器对前 20 条精排。、守护进程与 CLI 通过 Unix 域套接字通信；断线后 CLI 自动降级为直读 SQLite，恢复后重新接入队列。、所有解析与排版都在 Worker 中完成，主线程只处理输入、DOM overlay 与工具栏；没有跨线程的大对象拷贝。

补充说明：稠密向量检索擅长语义近似，但对专有名词与代码标识符的召回不稳定；稀疏检索（BM25）恰好互补。、倒数排名融合（RRF）以 1/(k+rank) 对各路结果加权求和，无需分数归一化，k 取 60 时在多数基准上表现稳健。、评测采用 nDCG@10 与 MRR 两个指标，黄金集为 20 条人工标注的单点定位题；重排阶段再以交叉编码器对前 20 条精排。、守护进程与 CLI 通过 Unix 域套接字通信；断线后 CLI 自动降级为直读 SQLite，恢复后重新接入队列。、所有解析与排版都在 Worker 中完成，主线程只处理输入、DOM overlay 与工具栏；没有跨线程的大对象拷贝。

补充说明：稠密向量检索擅长语义近似，但对专有名词与代码标识符的召回不稳定；稀疏检索（BM25）恰好互补。、倒数排名融合（RRF）以 1/(k+rank) 对各路结果加权求和，无需分数归一化，k 取 60 时在多数基准上表现稳健。、评测采用 nDCG@10 与 MRR 两个指标，黄金集为 20 条人工标注的单点定位题；重排阶段再以交叉编码器对前 20 条精排。、守护进程与 CLI 通过 Unix 域套接字通信；断线后 CLI 自动降级为直读 SQLite，恢复后重新接入队列。、所有解析与排版都在 Worker 中完成，主线程只处理输入、DOM overlay 与工具栏；没有跨线程的大对象拷贝。

补充说明：稠密向量检索擅长语义近似，但对专有名词与代码标识符的召回不稳定；稀疏检索（BM25）恰好互补。、倒数排名融合（RRF）以 1/(k+rank) 对各路结果加权求和，无需分数归一化，k 取 60 时在多数基准上表现稳健。、评测采用 nDCG@10 与 MRR 两个指标，黄金集为 20 条人工标注的单点定位题；重排阶段再以交叉编码器对前 20 条精排。、守护进程与 CLI 通过 Unix 域套接字通信；断线后 CLI 自动降级为直读 SQLite，恢复后重新接入队列。、所有解析与排版都在 Worker 中完成，主线程只处理输入、DOM overlay 与工具栏；没有跨线程的大对象拷贝。

补充说明：稠密向量检索擅长语义近似，但对专有名词与代码标识符的召回不稳定；稀疏检索（BM25）恰好互补。、倒数排名融合（RRF）以 1/(k+rank) 对各路结果加权求和，无需分数归一化，k 取 60 时在多数基准上表现稳健。、评测采用 nDCG@10 与 MRR 两个指标，黄金集为 20 条人工标注的单点定位题；重排阶段再以交叉编码器对前 20 条精排。、守护进程与 CLI 通过 Unix 域套接字通信；断线后 CLI 自动降级为直读 SQLite，恢复后重新接入队列。、所有解析与排版都在 Worker 中完成，主线程只处理输入、DOM overlay 与工具栏；没有跨线程的大对象拷贝。

补充说明：稠密向量检索擅长语义近似，但对专有名词与代码标识符的召回不稳定；稀疏检索（BM25）恰好互补。、倒数排名融合（RRF）以 1/(k+rank) 对各路结果加权求和，无需分数归一化，k 取 60 时在多数基准上表现稳健。、评测采用 nDCG@10 与 MRR 两个指标，黄金集为 20 条人工标注的单点定位题；重排阶段再以交叉编码器对前 20 条精排。、守护进程与 CLI 通过 Unix 域套接字通信；断线后 CLI 自动降级为直读 SQLite，恢复后重新接入队列。、所有解析与排版都在 Worker 中完成，主线程只处理输入、DOM overlay 与工具栏；没有跨线程的大对象拷贝。

补充说明：稠密向量检索擅长语义近似，但对专有名词与代码标识符的召回不稳定；稀疏检索（BM25）恰好互补。、倒数排名融合（RRF）以 1/(k+rank) 对各路结果加权求和，无需分数归一化，k 取 60 时在多数基准上表现稳健。、评测采用 nDCG@10 与 MRR 两个指标，黄金集为 20 条人工标注的单点定位题；重排阶段再以交叉编码器对前 20 条精排。、守护进程与 CLI 通过 Unix 域套接字通信；断线后 CLI 自动降级为直读 SQLite，恢复后重新接入队列。、所有解析与排版都在 Worker 中完成，主线程只处理输入、DOM overlay 与工具栏；没有跨线程的大对象拷贝。

补充说明：稠密向量检索擅长语义近似，但对专有名词与代码标识符的召回不稳定；稀疏检索（BM25）恰好互补。、倒数排名融合（RRF）以 1/(k+rank) 对各路结果加权求和，无需分数归一化，k 取 60 时在多数基准上表现稳健。、评测采用 nDCG@10 与 MRR 两个指标，黄金集为 20 条人工标注的单点定位题；重排阶段再以交叉编码器对前 20 条精排。、守护进程与 CLI 通过 Unix 域套接字通信；断线后 CLI 自动降级为直读 SQLite，恢复后重新接入队列。、所有解析与排版都在 Worker 中完成，主线程只处理输入、DOM overlay 与工具栏；没有跨线程的大对象拷贝。

补充说明：稠密向量检索擅长语义近似，但对专有名词与代码标识符的召回不稳定；稀疏检索（BM25）恰好互补。、倒数排名融合（RRF）以 1/(k+rank) 对各路结果加权求和，无需分数归一化，k 取 60 时在多数基准上表现稳健。、评测采用 nDCG@10 与 MRR 两个指标，黄金集为 20 条人工标注的单点定位题；重排阶段再以交叉编码器对前 20 条精排。、守护进程与 CLI 通过 Unix 域套接字通信；断线后 CLI 自动降级为直读 SQLite，恢复后重新接入队列。、所有解析与排版都在 Worker 中完成，主线程只处理输入、DOM overlay 与工具栏；没有跨线程的大对象拷贝。

补充说明：稠密向量检索擅长语义近似，但对专有名词与代码标识符的召回不稳定；稀疏检索（BM25）恰好互补。、倒数排名融合（RRF）以 1/(k+rank) 对各路结果加权求和，无需分数归一化，k 取 60 时在多数基准上表现稳健。、评测采用 nDCG@10 与 MRR 两个指标，黄金集为 20 条人工标注的单点定位题；重排阶段再以交叉编码器对前 20 条精排。、守护进程与 CLI 通过 Unix 域套接字通信；断线后 CLI 自动降级为直读 SQLite，恢复后重新接入队列。、所有解析与排版都在 Worker 中完成，主线程只处理输入、DOM overlay 与工具栏；没有跨线程的大对象拷贝。

补充说明：稠密向量检索擅长语义近似，但对专有名词与代码标识符的召回不稳定；稀疏检索（BM25）恰好互补。、倒数排名融合（RRF）以 1/(k+rank) 对各路结果加权求和，无需分数归一化，k 取 60 时在多数基准上表现稳健。、评测采用 nDCG@10 与 MRR 两个指标，黄金集为 20 条人工标注的单点定位题；重排阶段再以交叉编码器对前 20 条精排。、守护进程与 CLI 通过 Unix 域套接字通信；断线后 CLI 自动降级为直读 SQLite，恢复后重新接入队列。、所有解析与排版都在 Worker 中完成，主线程只处理输入、DOM overlay 与工具栏；没有跨线程的大对象拷贝。

补充说明：稠密向量检索擅长语义近似，但对专有名词与代码标识符的召回不稳定；稀疏检索（BM25）恰好互补。、倒数排名融合（RRF）以 1/(k+rank) 对各路结果加权求和，无需分数归一化，k 取 60 时在多数基准上表现稳健。、评测采用 nDCG@10 与 MRR 两个指标，黄金集为 20 条人工标注的单点定位题；重排阶段再以交叉编码器对前 20 条精排。、守护进程与 CLI 通过 Unix 域套接字通信；断线后 CLI 自动降级为直读 SQLite，恢复后重新接入队列。、所有解析与排版都在 Worker 中完成，主线程只处理输入、DOM overlay 与工具栏；没有跨线程的大对象拷贝。

补充说明：稠密向量检索擅长语义近似，但对专有名词与代码标识符的召回不稳定；稀疏检索（BM25）恰好互补。、倒数排名融合（RRF）以 1/(k+rank) 对各路结果加权求和，无需分数归一化，k 取 60 时在多数基准上表现稳健。、评测采用 nDCG@10 与 MRR 两个指标，黄金集为 20 条人工标注的单点定位题；重排阶段再以交叉编码器对前 20 条精排。、守护进程与 CLI 通过 Unix 域套接字通信；断线后 CLI 自动降级为直读 SQLite，恢复后重新接入队列。、所有解析与排版都在 Worker 中完成，主线程只处理输入、DOM overlay 与工具栏；没有跨线程的大对象拷贝。

补充说明：稠密向量检索擅长语义近似，但对专有名词与代码标识符的召回不稳定；稀疏检索（BM25）恰好互补。、倒数排名融合（RRF）以 1/(k+rank) 对各路结果加权求和，无需分数归一化，k 取 60 时在多数基准上表现稳健。、评测采用 nDCG@10 与 MRR 两个指标，黄金集为 20 条人工标注的单点定位题；重排阶段再以交叉编码器对前 20 条精排。、守护进程与 CLI 通过 Unix 域套接字通信；断线后 CLI 自动降级为直读 SQLite，恢复后重新接入队列。、所有解析与排版都在 Worker 中完成，主线程只处理输入、DOM overlay 与工具栏；没有跨线程的大对象拷贝。

补充说明：稠密向量检索擅长语义近似，但对专有名词与代码标识符的召回不稳定；稀疏检索（BM25）恰好互补。、倒数排名融合（RRF）以 1/(k+rank) 对各路结果加权求和，无需分数归一化，k 取 60 时在多数基准上表现稳健。、评测采用 nDCG@10 与 MRR 两个指标，黄金集为 20 条人工标注的单点定位题；重排阶段再以交叉编码器对前 20 条精排。、守护进程与 CLI 通过 Unix 域套接字通信；断线后 CLI 自动降级为直读 SQLite，恢复后重新接入队列。、所有解析与排版都在 Worker 中完成，主线程只处理输入、DOM overlay 与工具栏；没有跨线程的大对象拷贝。

补充说明：稠密向量检索擅长语义近似，但对专有名词与代码标识符的召回不稳定；稀疏检索（BM25）恰好互补。、倒数排名融合（RRF）以 1/(k+rank) 对各路结果加权求和，无需分数归一化，k 取 60 时在多数基准上表现稳健。、评测采用 nDCG@10 与 MRR 两个指标，黄金集为 20 条人工标注的单点定位题；重排阶段再以交叉编码器对前 20 条精排。、守护进程与 CLI 通过 Unix 域套接字通信；断线后 CLI 自动降级为直读 SQLite，恢复后重新接入队列。、所有解析与排版都在 Worker 中完成，主线程只处理输入、DOM overlay 与工具栏；没有跨线程的大对象拷贝。

补充说明：稠密向量检索擅长语义近似，但对专有名词与代码标识符的召回不稳定；稀疏检索（BM25）恰好互补。、倒数排名融合（RRF）以 1/(k+rank) 对各路结果加权求和，无需分数归一化，k 取 60 时在多数基准上表现稳健。、评测采用 nDCG@10 与 MRR 两个指标，黄金集为 20 条人工标注的单点定位题；重排阶段再以交叉编码器对前 20 条精排。、守护进程与 CLI 通过 Unix 域套接字通信；断线后 CLI 自动降级为直读 SQLite，恢复后重新接入队列。、所有解析与排版都在 Worker 中完成，主线程只处理输入、DOM overlay 与工具栏；没有跨线程的大对象拷贝。

补充说明：稠密向量检索擅长语义近似，但对专有名词与代码标识符的召回不稳定；稀疏检索（BM25）恰好互补。、倒数排名融合（RRF）以 1/(k+rank) 对各路结果加权求和，无需分数归一化，k 取 60 时在多数基准上表现稳健。、评测采用 nDCG@10 与 MRR 两个指标，黄金集为 20 条人工标注的单点定位题；重排阶段再以交叉编码器对前 20 条精排。、守护进程与 CLI 通过 Unix 域套接字通信；断线后 CLI 自动降级为直读 SQLite，恢复后重新接入队列。、所有解析与排版都在 Worker 中完成，主线程只处理输入、DOM overlay 与工具栏；没有跨线程的大对象拷贝。

补充说明：稠密向量检索擅长语义近似，但对专有名词与代码标识符的召回不稳定；稀疏检索（BM25）恰好互补。、倒数排名融合（RRF）以 1/(k+rank) 对各路结果加权求和，无需分数归一化，k 取 60 时在多数基准上表现稳健。、评测采用 nDCG@10 与 MRR 两个指标，黄金集为 20 条人工标注的单点定位题；重排阶段再以交叉编码器对前 20 条精排。、守护进程与 CLI 通过 Unix 域套接字通信；断线后 CLI 自动降级为直读 SQLite，恢复后重新接入队列。、所有解析与排版都在 Worker 中完成，主线程只处理输入、DOM overlay 与工具栏；没有跨线程的大对象拷贝。

补充说明：稠密向量检索擅长语义近似，但对专有名词与代码标识符的召回不稳定；稀疏检索（BM25）恰好互补。、倒数排名融合（RRF）以 1/(k+rank) 对各路结果加权求和，无需分数归一化，k 取 60 时在多数基准上表现稳健。、评测采用 nDCG@10 与 MRR 两个指标，黄金集为 20 条人工标注的单点定位题；重排阶段再以交叉编码器对前 20 条精排。、守护进程与 CLI 通过 Unix 域套接字通信；断线后 CLI 自动降级为直读 SQLite，恢复后重新接入队列。、所有解析与排版都在 Worker 中完成，主线程只处理输入、DOM overlay 与工具栏；没有跨线程的大对象拷贝。

补充说明：稠密向量检索擅长语义近似，但对专有名词与代码标识符的召回不稳定；稀疏检索（BM25）恰好互补。、倒数排名融合（RRF）以 1/(k+rank) 对各路结果加权求和，无需分数归一化，k 取 60 时在多数基准上表现稳健。、评测采用 nDCG@10 与 MRR 两个指标，黄金集为 20 条人工标注的单点定位题；重排阶段再以交叉编码器对前 20 条精排。、守护进程与 CLI 通过 Unix 域套接字通信；断线后 CLI 自动降级为直读 SQLite，恢复后重新接入队列。、所有解析与排版都在 Worker 中完成，主线程只处理输入、DOM overlay 与工具栏；没有跨线程的大对象拷贝。

补充说明：稠密向量检索擅长语义近似，但对专有名词与代码标识符的召回不稳定；稀疏检索（BM25）恰好互补。、倒数排名融合（RRF）以 1/(k+rank) 对各路结果加权求和，无需分数归一化，k 取 60 时在多数基准上表现稳健。、评测采用 nDCG@10 与 MRR 两个指标，黄金集为 20 条人工标注的单点定位题；重排阶段再以交叉编码器对前 20 条精排。、守护进程与 CLI 通过 Unix 域套接字通信；断线后 CLI 自动降级为直读 SQLite，恢复后重新接入队列。、所有解析与排版都在 Worker 中完成，主线程只处理输入、DOM overlay 与工具栏；没有跨线程的大对象拷贝。

补充说明：稠密向量检索擅长语义近似，但对专有名词与代码标识符的召回不稳定；稀疏检索（BM25）恰好互补。、倒数排名融合（RRF）以 1/(k+rank) 对各路结果加权求和，无需分数归一化，k 取 60 时在多数基准上表现稳健。、评测采用 nDCG@10 与 MRR 两个指标，黄金集为 20 条人工标注的单点定位题；重排阶段再以交叉编码器对前 20 条精排。、守护进程与 CLI 通过 Unix 域套接字通信；断线后 CLI 自动降级为直读 SQLite，恢复后重新接入队列。、所有解析与排版都在 Worker 中完成，主线程只处理输入、DOM overlay 与工具栏；没有跨线程的大对象拷贝。

补充说明：稠密向量检索擅长语义近似，但对专有名词与代码标识符的召回不稳定；稀疏检索（BM25）恰好互补。、倒数排名融合（RRF）以 1/(k+rank) 对各路结果加权求和，无需分数归一化，k 取 60 时在多数基准上表现稳健。、评测采用 nDCG@10 与 MRR 两个指标，黄金集为 20 条人工标注的单点定位题；重排阶段再以交叉编码器对前 20 条精排。、守护进程与 CLI 通过 Unix 域套接字通信；断线后 CLI 自动降级为直读 SQLite，恢复后重新接入队列。、所有解析与排版都在 Worker 中完成，主线程只处理输入、DOM overlay 与工具栏；没有跨线程的大对象拷贝。

补充说明：稠密向量检索擅长语义近似，但对专有名词与代码标识符的召回不稳定；稀疏检索（BM25）恰好互补。、倒数排名融合（RRF）以 1/(k+rank) 对各路结果加权求和，无需分数归一化，k 取 60 时在多数基准上表现稳健。、评测采用 nDCG@10 与 MRR 两个指标，黄金集为 20 条人工标注的单点定位题；重排阶段再以交叉编码器对前 20 条精排。、守护进程与 CLI 通过 Unix 域套接字通信；断线后 CLI 自动降级为直读 SQLite，恢复后重新接入队列。、所有解析与排版都在 Worker 中完成，主线程只处理输入、DOM overlay 与工具栏；没有跨线程的大对象拷贝。

补充说明：稠密向量检索擅长语义近似，但对专有名词与代码标识符的召回不稳定；稀疏检索（BM25）恰好互补。、倒数排名融合（RRF）以 1/(k+rank) 对各路结果加权求和，无需分数归一化，k 取 60 时在多数基准上表现稳健。、评测采用 nDCG@10 与 MRR 两个指标，黄金集为 20 条人工标注的单点定位题；重排阶段再以交叉编码器对前 20 条精排。、守护进程与 CLI 通过 Unix 域套接字通信；断线后 CLI 自动降级为直读 SQLite，恢复后重新接入队列。、所有解析与排版都在 Worker 中完成，主线程只处理输入、DOM overlay 与工具栏；没有跨线程的大对象拷贝。

补充说明：稠密向量检索擅长语义近似，但对专有名词与代码标识符的召回不稳定；稀疏检索（BM25）恰好互补。、倒数排名融合（RRF）以 1/(k+rank) 对各路结果加权求和，无需分数归一化，k 取 60 时在多数基准上表现稳健。、评测采用 nDCG@10 与 MRR 两个指标，黄金集为 20 条人工标注的单点定位题；重排阶段再以交叉编码器对前 20 条精排。、守护进程与 CLI 通过 Unix 域套接字通信；断线后 CLI 自动降级为直读 SQLite，恢复后重新接入队列。、所有解析与排版都在 Worker 中完成，主线程只处理输入、DOM overlay 与工具栏；没有跨线程的大对象拷贝。

补充说明：稠密向量检索擅长语义近似，但对专有名词与代码标识符的召回不稳定；稀疏检索（BM25）恰好互补。、倒数排名融合（RRF）以 1/(k+rank) 对各路结果加权求和，无需分数归一化，k 取 60 时在多数基准上表现稳健。、评测采用 nDCG@10 与 MRR 两个指标，黄金集为 20 条人工标注的单点定位题；重排阶段再以交叉编码器对前 20 条精排。、守护进程与 CLI 通过 Unix 域套接字通信；断线后 CLI 自动降级为直读 SQLite，恢复后重新接入队列。、所有解析与排版都在 Worker 中完成，主线程只处理输入、DOM overlay 与工具栏；没有跨线程的大对象拷贝。

补充说明：稠密向量检索擅长语义近似，但对专有名词与代码标识符的召回不稳定；稀疏检索（BM25）恰好互补。、倒数排名融合（RRF）以 1/(k+rank) 对各路结果加权求和，无需分数归一化，k 取 60 时在多数基准上表现稳健。、评测采用 nDCG@10 与 MRR 两个指标，黄金集为 20 条人工标注的单点定位题；重排阶段再以交叉编码器对前 20 条精排。、守护进程与 CLI 通过 Unix 域套接字通信；断线后 CLI 自动降级为直读 SQLite，恢复后重新接入队列。、所有解析与排版都在 Worker 中完成，主线程只处理输入、DOM overlay 与工具栏；没有跨线程的大对象拷贝。

补充说明：稠密向量检索擅长语义近似，但对专有名词与代码标识符的召回不稳定；稀疏检索（BM25）恰好互补。、倒数排名融合（RRF）以 1/(k+rank) 对各路结果加权求和，无需分数归一化，k 取 60 时在多数基准上表现稳健。、评测采用 nDCG@10 与 MRR 两个指标，黄金集为 20 条人工标注的单点定位题；重排阶段再以交叉编码器对前 20 条精排。、守护进程与 CLI 通过 Unix 域套接字通信；断线后 CLI 自动降级为直读 SQLite，恢复后重新接入队列。、所有解析与排版都在 Worker 中完成，主线程只处理输入、DOM overlay 与工具栏；没有跨线程的大对象拷贝。

补充说明：稠密向量检索擅长语义近似，但对专有名词与代码标识符的召回不稳定；稀疏检索（BM25）恰好互补。、倒数排名融合（RRF）以 1/(k+rank) 对各路结果加权求和，无需分数归一化，k 取 60 时在多数基准上表现稳健。、评测采用 nDCG@10 与 MRR 两个指标，黄金集为 20 条人工标注的单点定位题；重排阶段再以交叉编码器对前 20 条精排。、守护进程与 CLI 通过 Unix 域套接字通信；断线后 CLI 自动降级为直读 SQLite，恢复后重新接入队列。、所有解析与排版都在 Worker 中完成，主线程只处理输入、DOM overlay 与工具栏；没有跨线程的大对象拷贝。

补充说明：稠密向量检索擅长语义近似，但对专有名词与代码标识符的召回不稳定；稀疏检索（BM25）恰好互补。、倒数排名融合（RRF）以 1/(k+rank) 对各路结果加权求和，无需分数归一化，k 取 60 时在多数基准上表现稳健。、评测采用 nDCG@10 与 MRR 两个指标，黄金集为 20 条人工标注的单点定位题；重排阶段再以交叉编码器对前 20 条精排。、守护进程与 CLI 通过 Unix 域套接字通信；断线后 CLI 自动降级为直读 SQLite，恢复后重新接入队列。、所有解析与排版都在 Worker 中完成，主线程只处理输入、DOM overlay 与工具栏；没有跨线程的大对象拷贝。

补充说明：稠密向量检索擅长语义近似，但对专有名词与代码标识符的召回不稳定；稀疏检索（BM25）恰好互补。、倒数排名融合（RRF）以 1/(k+rank) 对各路结果加权求和，无需分数归一化，k 取 60 时在多数基准上表现稳健。、评测采用 nDCG@10 与 MRR 两个指标，黄金集为 20 条人工标注的单点定位题；重排阶段再以交叉编码器对前 20 条精排。、守护进程与 CLI 通过 Unix 域套接字通信；断线后 CLI 自动降级为直读 SQLite，恢复后重新接入队列。、所有解析与排版都在 Worker 中完成，主线程只处理输入、DOM overlay 与工具栏；没有跨线程的大对象拷贝。

补充说明：稠密向量检索擅长语义近似，但对专有名词与代码标识符的召回不稳定；稀疏检索（BM25）恰好互补。、倒数排名融合（RRF）以 1/(k+rank) 对各路结果加权求和，无需分数归一化，k 取 60 时在多数基准上表现稳健。、评测采用 nDCG@10 与 MRR 两个指标，黄金集为 20 条人工标注的单点定位题；重排阶段再以交叉编码器对前 20 条精排。、守护进程与 CLI 通过 Unix 域套接字通信；断线后 CLI 自动降级为直读 SQLite，恢复后重新接入队列。、所有解析与排版都在 Worker 中完成，主线程只处理输入、DOM overlay 与工具栏；没有跨线程的大对象拷贝。

补充说明：稠密向量检索擅长语义近似，但对专有名词与代码标识符的召回不稳定；稀疏检索（BM25）恰好互补。、倒数排名融合（RRF）以 1/(k+rank) 对各路结果加权求和，无需分数归一化，k 取 60 时在多数基准上表现稳健。、评测采用 nDCG@10 与 MRR 两个指标，黄金集为 20 条人工标注的单点定位题；重排阶段再以交叉编码器对前 20 条精排。、守护进程与 CLI 通过 Unix 域套接字通信；断线后 CLI 自动降级为直读 SQLite，恢复后重新接入队列。、所有解析与排版都在 Worker 中完成，主线程只处理输入、DOM overlay 与工具栏；没有跨线程的大对象拷贝。
