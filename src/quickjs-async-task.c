#include <pthread.h>
#include <stdint.h>
#include <stdlib.h>

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

/* Slots are allocated once (16) and never moved: a worker thread holds the
 * AsyncTask pointer, so realloc would dangle it. Returns NULL when all slots
 * are busy. */
AsyncTask *js_async_task_make_task(JSRuntime *rt)
{
    AsyncTaskState *r = find_runtime(rt);
    if (!r || !r->slots)
        return NULL;

    for (int i = 0; i < r->slots_capacity; i++) {
        AsyncTask *t = &r->slots[i];
        if (t->state != 0)
            continue;
        t->state = 1;
        t->result = NULL;
        t->arg = NULL;
        t->on_complete = NULL;
        t->event = r->event;
        r->slot_count++;
        return t;
    }
    return NULL;
}

void js_async_task_process(JSContext *ctx)
{
    JSRuntime *rt = JS_GetRuntime(ctx);
    AsyncTaskState *r = find_runtime(rt);
    if (!r || !r->slots) return;

    /* Single consumer: only the JS thread (js_os_poll) gets here, and each
     * slot is handed over by exactly one producer. */
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

#if QW_ASYNC_TASK_DEMO
/* fibAsync(n): the smallest end-to-end user of this module. The worker never
 * touches a JSValue; `arg` carries the slot's input and the promise resolver,
 * `result` carries the value back, and completion runs on the event loop. */
typedef struct {
    int n;
    JSValue resolve;
} FibArg;

static void *fib_worker(void *p)   /* plain C: pthread entry */
{
    AsyncTask *t = (AsyncTask *)p;
    FibArg *a = (FibArg *)t->arg;
    int64_t x = 0, y = 1;

    for (int i = 0; i < a->n; i++) {
        int64_t z = x + y;
        x = y;
        y = z;
    }
    t->result = (void *)(intptr_t)x;
    /* Publish order: result, then done, then wake-up. The event is auto-reset
     * and consumed by the wait, so marking the slot done after SetEvent would
     * lose the completion. SetEvent also keeps the two stores ordered. */
    t->state = 2;
    SetEvent(t->event);
    return NULL;
}

static void fib_on_complete(JSContext *ctx, AsyncTask *t)
{
    FibArg *a = (FibArg *)t->arg;
    JSValue v = JS_NewInt64(ctx, (int64_t)(intptr_t)t->result);

    JS_FreeValue(ctx, JS_Call(ctx, a->resolve, JS_UNDEFINED, 1, &v));
    JS_FreeValue(ctx, v);
    JS_FreeValue(ctx, a->resolve);
    free(a);
}

static JSValue js_fib_async(JSContext *ctx, JSValueConst this_val,
                            int argc, JSValueConst *argv)
{
    int n = 0;
    JS_ToInt32(ctx, &n, argv[0]);
    JSValue fn[2];
    JSValue promise = JS_NewPromiseCapability(ctx, fn);
    JS_FreeValue(ctx, fn[1]);  /* pure computation: nothing to reject */

    AsyncTask *t = js_async_task_make_task(JS_GetRuntime(ctx));
    if (!t) {
        JS_FreeValue(ctx, fn[0]);
        JS_FreeValue(ctx, promise);
        return JS_ThrowInternalError(ctx, "fibAsync: async slots busy");
    }
    FibArg *a = (FibArg *)malloc(sizeof(*a));
    a->n = n;
    a->resolve = fn[0];
    t->arg = a;
    t->on_complete = fib_on_complete;

    pthread_t tid;
    pthread_create(&tid, NULL, fib_worker, t);
    pthread_detach(tid);
    return promise;
}

void js_async_task_demo_install(JSContext *ctx)
{
    JSValue global = JS_GetGlobalObject(ctx);
    JS_SetPropertyStr(ctx, global, "fibAsync",
                      JS_NewCFunction(ctx, js_fib_async, "fibAsync", 1));
    JS_FreeValue(ctx, global);
}
#endif /* QW_ASYNC_TASK_DEMO */
