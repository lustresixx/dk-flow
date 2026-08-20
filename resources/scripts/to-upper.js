// 示例：把本次需求文本转为大写（内联 JS 沙箱脚本，可被 scriptFile 直接引用）
const text = context.requirements || context.inputs.requirements || ''
if (text.trim() === '') return { output: '输入为空', success: false }
return { output: text.toUpperCase(), success: true }
