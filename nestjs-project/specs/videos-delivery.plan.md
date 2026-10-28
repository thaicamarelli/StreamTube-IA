---
subproject: backend
runner: jest+supertest
scope: phase-03-videos
si: SI-03.8
target_file: test/videos-delivery.e2e-spec.ts
---

# GET /videos/:id, /stream, /download Test Plan

## Application Overview

Endpoints de leitura do status do vídeo e de entrega por streaming/download. Acesso anônimo permitido em todos os três — streaming e download exigem que o vídeo esteja `ready`, respondendo com um redirect pra uma URL pré-assinada do storage.

## Test Scenarios

### 1. Video detail read

**Setup:** `beforeEach` truncar as tabelas `videos`, `users`, `channels`; bootstrap do app via `Test.createTestingModule({ imports: [AppModule] }).compile()` reproduzindo `main.ts`; inserir vídeos de teste diretamente via `repository.save()` com os status necessários pra cada cenário (sem passar pelo fluxo de upload completo).

#### 1.1. existing-video-returns-200-with-fields

**Covers AC:** #1
**Source:** auto
**Last sync:** 2026-10-28T14:48:47Z

**Steps:**
  1. Inserir um `Video` com `status: "ready"`, `title: "Meu vídeo"`, `duration_seconds: 42`
  2. GET /videos/:id sem autenticação
    - expect: status `200`
    - expect: body contém `id`, `channelId`, `title: "Meu vídeo"`, `status: "ready"`, `durationSeconds: 42`, `errorReason: null`, `createdAt`

#### 1.2. nonexistent-video-returns-video-not-found

**Covers AC:** #2
**Source:** auto
**Last sync:** 2026-10-28T14:48:47Z

**Steps:**
  1. GET /videos/00000000-0000-0000-0000-000000000000 sem autenticação
    - expect: status `404`
    - expect: body `{ error: "VIDEO_NOT_FOUND" }`

### 2. Streaming and download delivery

**Setup:** mesmo setup da seção 1.

#### 2.1. ready-video-stream-redirects-with-inline-disposition

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-10-28T14:48:47Z

**Steps:**
  1. Inserir um `Video` com `status: "ready"` e `storage_key` apontando pra um objeto real no bucket `videos` do MinIO
  2. GET /videos/:id/stream sem autenticação
    - expect: status `302`
    - expect: header `Location` é uma URL assinada do MinIO cujo `response-content-disposition` é `inline`

#### 2.2. non-ready-video-stream-returns-video-not-ready

**Covers AC:** #4
**Source:** auto
**Last sync:** 2026-10-28T14:48:47Z

**Steps:**
  1. Inserir um `Video` com `status: "processing"`
  2. GET /videos/:id/stream sem autenticação
    - expect: status `409`
    - expect: body `{ error: "VIDEO_NOT_READY" }`

#### 2.3. ready-video-download-redirects-with-attachment-disposition

**Covers AC:** #5
**Source:** auto
**Last sync:** 2026-10-28T14:48:47Z

**Steps:**
  1. Inserir um `Video` com `status: "ready"`, `original_filename: "meu-video.mp4"` e `storage_key` apontando pra um objeto real no bucket `videos` do MinIO
  2. GET /videos/:id/download sem autenticação
    - expect: status `302`
    - expect: header `Location` é uma URL assinada do MinIO cujo `response-content-disposition` é `attachment; filename="meu-video.mp4"`
