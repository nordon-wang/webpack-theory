const path = require('path')
const fs = require('fs')

const parser = require('@babel/parser')
// 由于traverse是es6语法导出，需要添加.default获取
const traverse = require('@babel/traverse').default
const generator = require('@babel/generator').default
const ejs = require('ejs')
const {
  SyncHook
} = require('tapable')

class Compiler {
  constructor(config) {
    this.config = config
    const {
      entry,
      output
    } = config
    this.entry = entry
    this.output = output
    this.rules = this.config.module.rules

    this.root = process.cwd() // 获取执行 webpack-theory 指令的目录，当前命令窗口进程的路径
    this.modules = {} // 初始化一个控对象，存放所有的模块

    // tapable 的构造函数内部定义的钩子
    this.hooks = {
      compiler: new SyncHook(),
      afterPlugins: new SyncHook(),
      beforeRun: new SyncHook(),
      run: new SyncHook(),
      make: new SyncHook(),
      afterCompiler: new SyncHook(),
      shouldEmit: new SyncHook(),
      emit: new SyncHook(),
      afterEmit: new SyncHook(['compilation']),
      done: new SyncHook(),
    }

    // 触发所有插件的apply方法， 并传入Compiler对象
    if (Array.isArray(this.config.plugins)) {
      this.config.plugins.forEach(plugin => {
        plugin.apply(this)
      });
    }

  }

  /**
   * 开始打包
   *  打包最主要的就是依赖的分析
   */
  start() {
    this.hooks.compiler.call() // 开始编译
    // 传递绝对路径
    // path.resolve(__dirname, this.entry) 是错误的，因为__dirname 表示的是webpack-theory所在的目录路径，并不是入口文件 entry所在的目录
    // 若需要获取执行webpack-theory指令的目录，需要使用process.cwd()
    this.depAnalyse(path.resolve(this.root, this.entry))
    // console.log(this.modules);
    this.hooks.afterCompiler.call() //编译完成了
    this.hooks.emit.call() // 开始发射文件
    this.emitFile()
    this.hooks.afterEmit.call() // 文件已发射完成
    this.hooks.done.call() // 完成
  }

  // 根据写好的模板 创建文件
  emitFile() {

    const template = this.getSource(path.join(__dirname, '../template/output.ejs'))
    const result = ejs.render(template, {
      entry: this.entry,
      modules: this.modules
    })

    const {
      path: filePath,
      filename
    } = this.output

    const outputPath = path.join(filePath, filename)

    fs.writeFile(outputPath, result, (err) => {
      console.log(err ? err : '打包完成');
    })

  }

  /**
   * 依赖分析
   *  需要根据入口entry进行开始分析
   */
  depAnalyse(modulePath) {
    // console.log('modulePath', modulePath);
    // 读取文件内容
    let source = this.getSource(modulePath)

    // 内部定义一个处理loader的函数
    const _handleLoader = (usePath, _this) => {
      const loaderPath = path.join(this.root, usePath)
      const loader = require(loaderPath)
      source = loader.call(_this, source)
    }

    // 读取 rules 规则, 进行倒序遍历
    const rules = this.rules
    for (let i = rules.length - 1; i >= 0; i--) {
      const {
        test,
        use
      } = rules[i]

      // 匹配 modulePath 是否符合规则，若是符合规则就需要倒序遍历获取所有的loader
      // 获取每一条规则，和当前的 modulePath 进行匹配
      if (test.test(modulePath)) {
        // use 可能是 数组、对象、字符串
        if (Array.isArray(use)) {
          // array
          for (let j = use.length - 1; j >= 0; j--) {
            // const loaderPath = path.join(this.root, use[j])
            // const loader = require(loaderPath)
            // source = loader(source)
            _handleLoader(use[j])
          }
        } else if (typeof use === 'string') {
          // string
          _handleLoader(use)
        } else if (use instanceof Object) {
          // object
          _handleLoader(use.path, {
            query: use.options
          })
        }
      }
    }


    // 准备一个依赖数组，用于存储当前模块
    let dependenceArr = []
    // ast语法树
    const ast = parser.parse(source)

    traverse(ast, {
      // p 是抽象语法树的节点
      CallExpression(p) {
        if (p.node.callee.name === 'require') {
          // 将代码中的 require 替换为 __webpack_require__
          p.node.callee.name = '__webpack_require__'
          const oldValue = p.node.arguments[0].value
          // 修改路径，避免windows出现反斜杠 \
          p.node.arguments[0].value = ('./' + path.join('src', oldValue)).replace(/\\+/g, '/')

          // 每找到一个require调用，就将其中的路径修改完毕后加入到依赖数组中
          dependenceArr.push(p.node.arguments[0].value)
        }
      }
    })

    // 构建modules对象
    const sourceCode = generator(ast).code
    const modulePathRelative = './' + (path.relative(this.root, modulePath)).replace(/\\+/g, '/')
    this.modules[modulePathRelative] = sourceCode

    // 递归调用加载所有依赖
    dependenceArr.forEach(dep => this.depAnalyse(path.resolve(this.root, dep)))

  }

  // 读取文件
  getSource(path) {
    return fs.readFileSync(path, 'utf-8')
  }
}


module.exports = Compiler