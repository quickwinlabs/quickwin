(module
  (import "env" "log_i32" (func $log_i32 (param i32)))
  (import "env" "log_i64" (func $log_i64 (param i64)))
  (import "env" "log_f32" (func $log_f32 (param f32)))
  (import "env" "log_f64" (func $log_f64 (param f64)))
  (import "env" "op_i32" (func $op_i32 (param i32 i32 i32) (result i32)))

  (func (export "run_i32") (param i32) (result i32)
    local.get 0
    i32.const 10
    i32.const 5
    call $op_i32
    local.tee 0
    call $log_i32
    local.get 0
  )

  (func (export "run_i64") (param i64 i64) (result i64)
    local.get 0
    local.get 1
    i64.add
    local.tee 0
    call $log_i64
    local.get 0
  )

  (func (export "run_f32") (param f32) (result f32)
    local.get 0
    f32.const 2.0
    f32.mul
    local.tee 0
    call $log_f32
    local.get 0
  )

  (func (export "run_f64") (param f64 f64) (result f64)
    local.get 0
    local.get 1
    f64.mul
    local.tee 0
    call $log_f64
    local.get 0
  )
)
