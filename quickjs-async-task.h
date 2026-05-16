#pragma once
#include <windows.h>
#include "quickjs.h"

#define MAX_ASYNC_TASKS 16

typedef struct AsyncTask {
    volatile LONG state;   // 0=idle 1=running 2=done
    void *result;          // BG 线程 malloc，on_complete 里 free
    void *arg;             // 输入参数，调用方分配，BG 只读
    void (*on_complete)(JSContext *ctx, struct AsyncTask *task);
    HANDLE event;          // make_task 时自动填入
} AsyncTask;

typedef struct {
    JSRuntime *rt;
    HANDLE event;
    AsyncTask slots[MAX_ASYNC_TASKS];
    int slot_count;
} AsyncTaskRuntime;

AsyncTaskRuntime *js_async_task_init(JSRuntime *rt);
HANDLE            js_async_task_get_event(JSRuntime *rt);
int               js_async_task_slot_count(JSRuntime *rt);
AsyncTask        *js_async_task_make_task(JSRuntime *rt);
void              js_async_task_process(JSContext *ctx);
void              js_async_task_destroy(JSRuntime *rt);
