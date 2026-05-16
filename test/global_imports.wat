(module
  (import "env" "offset" (global $offset i32))
  (import "env" "factor" (global $factor f64))
  (import "env" "log" (func $log (param i32)))
  (global (export "offset") i32 (global.get $offset))
  (global (export "factor") f64 (global.get $factor))
  (func (export "get_offset") (result i32)
    global.get $offset)
  (func (export "compute") (param f64) (result f64)
    local.get 0
    global.get $factor
    f64.mul)
  (func (export "run") (param i32) (result i32)
    local.get 0
    global.get $offset
    i32.add
    local.tee 0
    call $log
    local.get 0)
)
