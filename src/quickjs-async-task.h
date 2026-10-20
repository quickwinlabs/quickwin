#pragma once
#include <windows.h>
#include "quickjs.h"

typedef struct AsyncTask {
    volatile LONG state;   // 0=idle 1=running 2=done
    void *result;          // BG 线程 malloc，on_complete 里 free
    void *arg;             // 输入参数，调用方分配，BG 只读
    void (*on_complete)(JSContext *ctx, struct AsyncTask *task);
    HANDLE event;          // make_task 时自动填入
} AsyncTask;

typedef struct {
    HANDLE event;
    AsyncTask *slots;      // dynamic array
    int slot_count;        // how many slots are in use
    int slots_capacity;    // allocated size
} AsyncTaskState;

/* Smoke test for the plumbing: build with -DQW_ASYNC_TASK_DEMO=1 (`make
 * ASYNC_DEMO=1`) to expose globalThis.fibAsync(n) => Promise<number>. */
#ifndef QW_ASYNC_TASK_DEMO
#define QW_ASYNC_TASK_DEMO 0
#endif
#if QW_ASYNC_TASK_DEMO
void js_async_task_demo_install(JSContext *ctx);
#endif

/* state lives in JSThreadState.async_task */
AsyncTaskState *js_async_task_init(JSRuntime *rt);
HANDLE            js_async_task_get_event(JSRuntime *rt);
int               js_async_task_slot_count(JSRuntime *rt);
AsyncTask        *js_async_task_make_task(JSRuntime *rt);  /* NULL when all 16 slots are busy */
void              js_async_task_process(JSContext *ctx);
void              js_async_task_destroy(JSRuntime *rt);
