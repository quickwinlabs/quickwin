(module
  (func (export "add_i32") (param i32 i32) (result i32)
    local.get 0
    local.get 1
    i32.add
  )

  (func (export "add_i64") (param i64 i64) (result i64)
    local.get 0
    local.get 1
    i64.add
  )

  (func (export "add_f32") (param f32 f32) (result f32)
    local.get 0
    local.get 1
    f32.add
  )

  (func (export "add_f64") (param f64 f64) (result f64)
    local.get 0
    local.get 1
    f64.add
  )

  (func (export "mixed_args") (param i32 i64 f32 f64) (result f64)
    local.get 0
    f64.convert_i32_s
    local.get 1
    f64.convert_i64_s
    f64.add
    local.get 2
    f64.promote_f32
    f64.add
    local.get 3
    f64.add
  )

  (func $factorial (export "factorial_i64") (param i64) (result i64)
    (if (result i64) (i64.le_s (local.get 0) (i64.const 1))
      (then (i64.const 1))
      (else
        (i64.mul
          (local.get 0)
          (call $factorial (i64.sub (local.get 0) (i64.const 1)))
        )
      )
    )
  )

  (func (export "sqrt_f64") (param f64) (result f64)
    local.get 0
    f64.sqrt
  )

  (memory (export "memory") 1)
  (func (export "write_memory") (param i32 i32)
    local.get 0
    local.get 1
    i32.store
  )
  (func (export "read_memory") (param i32) (result i32)
    local.get 0
    i32.load
  )

  (global (export "const_i32") i32 (i32.const 42))
  (global (export "const_f64") f64 (f64.const 3.14))
  (global $mutable_i32 (export "mutable_i32") (mut i32) (i32.const 99))
  (func (export "read_mut_global") (result i32)
    global.get $mutable_i32
  )
)
