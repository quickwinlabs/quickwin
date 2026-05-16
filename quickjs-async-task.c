#include "quickjs-async-task.h"

#define MAX_RUNTIMES 4

static AsyncTaskRuntime g_runtimes[MAX_RUNTIMES];
static int g_nruntimes;

static AsyncTaskRuntime *find_runtime(JSRuntime *rt)
{
    for (int i = 0; i < g_nruntimes; i++) {
        if (g_runtimes[i].rt == rt)
            return &g_runtimes[i];
    }
    return NULL;
}

AsyncTaskRuntime *js_async_task_init(JSRuntime *rt)
{
    if (g_nruntimes >= MAX_RUNTIMES)
        return NULL;

    AsyncTaskRuntime *r = &g_runtimes[g_nruntimes++];
    r->rt = rt;
    r->event = CreateEvent(NULL, FALSE, FALSE, NULL);
    r->slot_count = 0;
    for (int i = 0; i < MAX_ASYNC_TASKS; i++)
        r->slots[i].state = 0;
    return r;
}

HANDLE js_async_task_get_event(JSRuntime *rt)
{
    AsyncTaskRuntime *r = find_runtime(rt);
    return r ? r->event : NULL;
}

int js_async_task_slot_count(JSRuntime *rt)
{
    AsyncTaskRuntime *r = find_runtime(rt);
    return r ? r->slot_count : 0;
}

AsyncTask *js_async_task_make_task(JSRuntime *rt)
{
    AsyncTaskRuntime *r = find_runtime(rt);
    if (!r)
        return NULL;

    for (int i = 0; i < MAX_ASYNC_TASKS; i++) {
        if (r->slots[i].state == 0) {
            r->slots[i].state = 1;
            r->slots[i].result = NULL;
            r->slots[i].arg = NULL;
            r->slots[i].on_complete = NULL;
            r->slots[i].event = r->event;
            r->slot_count++;
            return &r->slots[i];
        }
    }
    return NULL;
}

void js_async_task_process(JSContext *ctx)
{
    JSRuntime *rt = JS_GetRuntime(ctx);
    AsyncTaskRuntime *r = find_runtime(rt);
    if (!r)
        return;

    for (int i = 0; i < MAX_ASYNC_TASKS; i++) {
        AsyncTask *t = &r->slots[i];
        if (t->state == 2) {
            if (t->on_complete)
                t->on_complete(ctx, t);
            t->state = 0;
            t->result = NULL;
            t->on_complete = NULL;
            r->slot_count--;
        }
    }
}

void js_async_task_destroy(JSRuntime *rt)
{
    AsyncTaskRuntime *r = find_runtime(rt);
    if (!r)
        return;
    if (r->event) {
        CloseHandle(r->event);
        r->event = NULL;
    }
    r->slot_count = 0;
}
