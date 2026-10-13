#ifndef QUICKJS_THREAD_STATE_H
#define QUICKJS_THREAD_STATE_H

#include "quickjs.h"
#include "list.h"
#include "quickjs-sock.h"
#include "quickjs-async-task.h"

typedef struct JSWorkerMessagePipe JSWorkerMessagePipe;

typedef struct JSThreadState {
    struct list_head os_rw_handlers; /* list of JSOSRWHandler.link */
    struct list_head os_signal_handlers; /* list JSOSSignalHandler.link */
    struct list_head os_timers; /* list of JSOSTimer.link */
    struct list_head port_list; /* list of JSWorkerMessageHandler.link */
    struct list_head rejected_promise_list; /* list of JSRejectedPromiseEntry.link */
    int eval_script_recurse; /* only used in the main thread */
    int next_timer_id; /* for setTimeout() */
    /* not used in the main thread */
    JSWorkerMessagePipe *recv_pipe, *send_pipe;
    SockState sock;       /* per-runtime sock slots (no global table) */
    AsyncTaskState async_task; /* per-runtime async task slots */
} JSThreadState;

#endif
