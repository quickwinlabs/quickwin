#ifndef QUICKJS_GUI_H
#define QUICKJS_GUI_H

#include "quickjs.h"

extern JSContext *g_ctx;

void gui_cleanup(void);
JSModuleDef *js_init_module_gui(JSContext *ctx);

#endif