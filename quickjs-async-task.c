#include "quickjs-async-task.h"
#include "quickjs-thread-state.h"

/* per-runtime state embedded in JSThreadState; no global table */
static AsyncTaskState *find_runtime(JSRuntime *rt)
{
    JSThreadState *ts = JS_GetRuntimeOpaque(rt);
    return ts ? &ts->async_task : NULL;
}

AsyncTaskState *js_async_task_init(JSRuntime *rt)
{
    JSThreadState *ts = JS_GetRuntimeOpaque(rt);
    if (!ts)
        return NULL;
    AsyncTaskState *r = &ts->async_task;
    if (r->event || r->slots)
        return r;
    r->event = CreateEvent(NULL, FALSE, FALSE, NULL);
    r->slots_capacity = 16;
    r->slots = js_mallocz_rt(rt, r->slots_capacity * sizeof(AsyncTask));
    r->slot_count = 0;
    return r;
}

HANDLE js_async_task_get_event(JSRuntime *rt)
{
    AsyncTaskState *r = find_runtime(rt);
    return r ? r->event : NULL;
}

int js_async_task_slot_count(JSRuntime *rt)
{
    AsyncTaskState *r = find_runtime(rt);
    return r ? r->slot_count : 0;
}

AsyncTask *js_async_task_make_task(JSRuntime *rt)
{
    AsyncTaskState *r = find_runtime(rt);
    if (!r || !r->slots)
        return NULL;

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

    int oldCap = r->slots_capacity;
    int newCap = oldCap * 2;
    AsyncTask *p = js_realloc_rt(rt, r->slots, newCap * sizeof(AsyncTask));
    if (!p) return NULL;
    r->slots = p;
    for (int i = oldCap; i < newCap; i++) {
        r->slots[i].state = 0;
        r->slots[i].result = NULL;
        r->slots[i].arg = NULL;
        r->slots[i].on_complete = NULL;
        r->slots[i].event = NULL;
    }
    r->slots_capacity = newCap;

    AsyncTask *t = &r->slots[oldCap];
    t->state = 1;
    t->event = r->event;
    r->slot_count++;
    return t;
}

void js_async_task_process(JSContext *ctx)
{
    JSRuntime *rt = JS_GetRuntime(ctx);
    AsyncTaskState *r = find_runtime(rt);
    if (!r || !r->slots) return;

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
    AsyncTaskState *r = find_runtime(rt);
    if (!r) return;
    if (r->event) {
        CloseHandle(r->event);
        r->event = NULL;
    }
    if (r->slots) {
        js_free_rt(rt, r->slots);
        r->slots = NULL;
    }
    r->slot_count = 0;
    r->slots_capacity = 0;
}
