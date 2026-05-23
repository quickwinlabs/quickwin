#include "quickjs-async-task.h"

static AsyncTaskRuntime *g_runtimes = NULL;
static int g_nruntimes = 0;
static int g_runtimes_capacity = 0;

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
    if (g_nruntimes >= g_runtimes_capacity) {
        int newCap = g_runtimes_capacity ? g_runtimes_capacity * 2 : 4;
        AsyncTaskRuntime *p = realloc(g_runtimes, newCap * sizeof(AsyncTaskRuntime));
        if (!p) return NULL;
        g_runtimes = p;
        g_runtimes_capacity = newCap;
    }

    AsyncTaskRuntime *r = &g_runtimes[g_nruntimes++];
    r->rt = rt;
    r->event = CreateEvent(NULL, FALSE, FALSE, NULL);
    r->slots_capacity = 16;
    r->slots = js_mallocz_rt(rt, r->slots_capacity * sizeof(AsyncTask));
    r->slot_count = 0;
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
    if (!r) return NULL;

    for (int i = 0; i < r->slots_capacity; i++) {
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

    int newCap = r->slots_capacity * 2;
    AsyncTask *p = js_realloc_rt(rt, r->slots, newCap * sizeof(AsyncTask));
    if (!p) return NULL;
    r->slots = p;
    for (int i = r->slots_capacity; i < newCap; i++)
        r->slots[i].state = 0;
    r->slots_capacity = newCap;

    r->slots[r->slots_capacity / 2].state = 1;
    r->slots[r->slots_capacity / 2].event = r->event;
    r->slot_count++;
    return &r->slots[r->slots_capacity / 2];
}

void js_async_task_process(JSContext *ctx)
{
    JSRuntime *rt = JS_GetRuntime(ctx);
    AsyncTaskRuntime *r = find_runtime(rt);
    if (!r) return;

    for (int i = 0; i < r->slots_capacity; i++) {
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
    if (!r) return;
    if (r->event) {
        CloseHandle(r->event);
        r->event = NULL;
    }
    js_free_rt(rt, r->slots);
    r->slots = NULL;
    r->slot_count = 0;
    r->slots_capacity = 0;
}

void js_async_task_cleanup(void)
{
    free(g_runtimes);
    g_runtimes = NULL;
    g_nruntimes = 0;
    g_runtimes_capacity = 0;
}
