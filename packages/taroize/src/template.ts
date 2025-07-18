import { dirname, extname, join, relative, resolve } from 'node:path'

import * as t from '@babel/types'
import { fs } from '@tarojs/helper'

import { errors } from './global'
import {
  astToCode,
  buildBlockElement,
  buildRender,
  getLineBreak,
  IReportError,
  pascalName,
  setting,
  updateLogFileContent,
} from './utils'
import { createWxmlVisitor, parseWXML, WXS } from './wxml'

import type { NodePath } from '@babel/traverse'

function isNumeric (n) {
  return !isNaN(parseFloat(n)) && isFinite(n)
}

const NumberWords = ['z', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k']

export function buildTemplateName (name: string, pascal = true): string {
  if (/wx/i.test(name)) {
    return buildTemplateName('taro-' + name.slice(2, name.length))
  }
  const words = pascal ? pascalName(name + '-tmpl') : name + '-tmpl'
  // return words
  const str: string[] = []
  for (const word of words) {
    if (isNumeric(word)) {
      str.push(NumberWords[word])
    } else {
      str.push(word)
    }
  }

  return str.join('')
}

/**
 * 支持 import 的 src 绝对路径转为相对路径
 *
 * @param dirPath 文件目录的绝对路径
 * @param srcPath import 的 src 路径
 * @returns 处理后的相对路径
 */
export function getSrcRelPath (dirPath: string, srcPath: string) {
  if (srcPath.startsWith('/')) {
    const absolutPath = join(setting.rootPath, srcPath.substr(1))
    if (!fs.existsSync(absolutPath) && !fs.existsSync(`${absolutPath}.wxml`)) {
      throw new Error(`import/include 的 src 请填入正确路径再进行转换：src="${srcPath}"`)
    }
    let relativePath = relative(dirPath, absolutPath)
    relativePath = relativePath.replace(/\\/g, '/')
    if (relativePath.indexOf('.') !== 0) {
      srcPath = './' + relativePath
      return srcPath
    } else {
      return relativePath
    }
  } else {
    return srcPath
  }
}

/**
 * @description 预解析 template 模板
 * @param path template 在 AST 中的区域
 * @returns
 */
export function preParseTemplate (path: NodePath<t.JSXElement>) {
  if (!path.container) {
    return
  }
  const openingElement = path.get('openingElement')
  const attrs = openingElement.get('attributes')
  const name = attrs.find(
    (attr) =>
      t.isJSXAttribute(attr as any) &&
      t.isJSXIdentifier(attr!.get('name') as any) &&
      t.isJSXAttribute(attr.node) &&
      attr.node.name.name === 'name'
  )
  if (!(name && t.isJSXAttribute(name.node))) {
    return
  }
  // 获取 template name
  const value = name.node.value
  if (value === null || !t.isStringLiteral(value)) {
    // @ts-ignore
    const { line, column } = path.node?.position?.start || { line: 0, column: 0 }
    const position = { col: column, row: line }
    throw new IReportError(
      'template 的 `name` 属性只能是字符串',
      'TemplateNameTypeMismatchError',
      'WXML_FILE',
      astToCode(path.node) || '',
      position
    )
  }
  const templateName = buildTemplateName(value.value)
  const templateFuncs = new Set<string>()
  const templateApplies = new Set<string>()
  path.traverse({
    JSXAttribute (p) {
      updateLogFileContent(`INFO [taroize] preParseTemplate - 解析 JSXAttribute ${getLineBreak()}${p} ${getLineBreak()}`)
      // 获取 template 方法
      const node = p.node
      if (
        t.isJSXExpressionContainer(node.value) &&
        t.isMemberExpression(node.value.expression) &&
        t.isThisExpression(node.value.expression.object) &&
        t.isIdentifier(node.value.expression.property)
      ) {
        // funcName 加入到 funcs
        const funcName = node.value.expression.property.name
        if (!templateFuncs.has(funcName)) {
          templateFuncs.add(funcName)
        }
      }
    },
    JSXOpeningElement (p) {
      updateLogFileContent(
        `INFO [taroize] preParseTemplate - 解析 JSXOpeningElement ${getLineBreak()}${p} ${getLineBreak()}`
      )
      // 获取 template 调用的模板
      const attrs = p.get('attributes')
      const is = attrs.find(
        (attr) =>
          t.isJSXAttribute(attr as any) &&
          t.isJSXIdentifier(attr!.get('name') as any) &&
          t.isJSXAttribute(attr.node) &&
          attr.node.name.name === 'is'
      )
      if (!(is && t.isJSXAttribute(is.node))) {
        return
      }
      const value = is.node.value
      if (!value) {
        // @ts-ignore
        const { line, column } = p.node?.position?.start || { line: 0, column: 0 }
        const position = { col: column, row: line }
        throw new IReportError(
          'template 的 `is` 属性不能为空',
          'TemplateIsAttributeEmptyError',
          'WXML_FILE',
          astToCode(path.node) || '',
          position
        )
      }
      // is 的模板调用形式为 is="xxx", xxx 为模板名或表达式
      if (t.isStringLiteral(value)) {
        const apply = buildTemplateName(value.value)
        templateApplies.add(apply)
      }
    },
  })
  return {
    name: templateName,
    funcs: templateFuncs,
    applies: templateApplies,
  }
}

export function parseTemplate (path: NodePath<t.JSXElement>, dirPath: string, wxses: WXS[]) {
  if (!path.container || !path.isJSXElement()) {
    return
  }
  updateLogFileContent(
    `INFO [taroize] parseTemplate - 入参 ${getLineBreak()}path: ${path}, dirPath: ${dirPath} ${getLineBreak()}`
  )
  const openingElement = path.get('openingElement')
  const attrs = openingElement.get('attributes')
  const is = attrs.find(
    (attr) =>
      t.isJSXAttribute(attr as any) &&
      t.isJSXIdentifier(attr!.get('name') as any) &&
      t.isJSXAttribute(attr.node) &&
      attr.node.name.name === 'is'
  )
  const data = attrs.find(
    (attr) =>
      t.isJSXAttribute(attr as any) &&
      t.isJSXIdentifier(attr!.get('name') as any) &&
      t.isJSXAttribute(attr.node) &&
      attr.node.name.name === 'data'
  )
  const name = attrs.find(
    (attr) =>
      t.isJSXAttribute(attr as any) &&
      t.isJSXIdentifier(attr!.get('name') as any) &&
      t.isJSXAttribute(attr.node) &&
      attr.node.name.name === 'name'
  )

  const refIds = new Set<string>()
  const loopIds = new Set<string>()
  const imports: any[] = []
  if (name && t.isJSXAttribute(name.node)) {
    const value = name.node.value
    if (value === null || !t.isStringLiteral(value)) {
      throw new Error('template 的 `name` 属性只能是字符串')
    }
    // 收集 template 原始 name, 作为 map 的 key
    const templateName = value.value
    const className = buildTemplateName(value.value)

    path.traverse(createWxmlVisitor(loopIds, refIds, dirPath, [], imports))

    // refIds 中可能包含 wxs 模块，应从 refIds 中去除并单独以模块的形式导入
    const usedWxses = new Set<WXS>()
    const refdata = refIds
    refdata.forEach((refId) => {
      wxses.forEach((wxsId) => {
        if (wxsId.module.includes(refId)) {
          usedWxses.add(wxsId)
          refIds.delete(refId)
        }
      })
    })

    const firstId = Array.from(refIds)[0]
    refIds.forEach((id) => {
      if (loopIds.has(id) && id !== firstId) {
        refIds.delete(id)
      }
    })

    const block = buildBlockElement()
    block.children = path.node.children
    let render: t.ClassMethod
    if (refIds.size === 0) {
      // 无状态组件
      render = buildRender(block, [], [])
    } else if (refIds.size === 1) {
      // 只有一个数据源
      render = buildRender(block, [], Array.from(refIds), [])
    } else {
      // 使用 ...spread
      render = buildRender(block, [], Array.from(refIds), [])
    }
    const classDecl = t.classDeclaration(
      t.identifier(className),
      t.memberExpression(t.identifier('React'), t.identifier('Component')),
      t.classBody([render]),
      []
    )
    // 添加 withWeapp 装饰器
    classDecl.decorators = [t.decorator(t.callExpression(t.identifier('withWeapp'), [t.objectExpression([])]))]
    path.remove()
    return {
      name: className,
      ast: classDecl,
      tmplName: templateName,
      usedWxses: usedWxses,
    }
  } else if (is && t.isJSXAttribute(is.node)) {
    const value = is.node.value
    if (!value) {
      // @ts-ignore
      const { line, column } = path.node?.position?.start || { line: 0, column: 0 }
      const position = { col: column, row: line }
      throw new IReportError(
        'template 的 `is` 属性不能为空',
        'TemplateIsAttributeEmptyError',
        'WXML_FILE',
        astToCode(path.node) || '',
        position
      )
    }
    if (t.isStringLiteral(value)) {
      const className = buildTemplateName(value.value)
      const attributes: t.JSXAttribute[] = []
      if (data && t.isJSXAttribute(data.node)) {
        attributes.push(data.node)
      }
      path.replaceWith(
        t.jSXElement(
          t.jSXOpeningElement(t.jSXIdentifier(className), attributes),
          t.jSXClosingElement(t.jSXIdentifier(className)),
          [],
          true
        )
      )
    } else if (t.isJSXExpressionContainer(value)) {
      if (t.isStringLiteral(value.expression)) {
        const className = buildTemplateName(value.expression.value)
        const attributes: t.JSXAttribute[] = []
        if (data && t.isJSXAttribute(data.node)) {
          attributes.push(data.node)
        }
        path.replaceWith(
          t.jSXElement(
            t.jSXOpeningElement(t.jSXIdentifier(className), attributes),
            t.jSXClosingElement(t.jSXIdentifier(className)),
            [],
            true
          )
        )
      } else if (t.isConditional(value.expression)) {
        const { test, consequent, alternate } = value.expression
        if (!t.isStringLiteral(consequent) || !t.isStringLiteral(alternate)) {
          // @ts-ignore
          const { line, column } = path.node?.position?.start || { line: 0, column: 0 }
          const position = { col: column, row: line }
          throw new IReportError(
            '当 template is 标签是三元表达式时，他的两个值都必须为字符串',
            'TemplateIsAttributeTypeMismatchError',
            'WXML_FILE',
            astToCode(path.node) || '',
            position
          )
        }
        const attributes: t.JSXAttribute[] = []
        if (data && t.isJSXAttribute(data.node)) {
          attributes.push(data.node)
        }
        const block = buildBlockElement()
        block.children = [
          t.jSXExpressionContainer(
            t.conditionalExpression(
              test,
              t.jSXElement(
                t.jSXOpeningElement(
                  t.jSXIdentifier('Template'),
                  attributes.concat([t.jSXAttribute(t.jSXIdentifier('is'), consequent)])
                ),
                t.jSXClosingElement(t.jSXIdentifier('Template')),
                [],
                true
              ),
              t.jSXElement(
                t.jSXOpeningElement(
                  t.jSXIdentifier('Template'),
                  attributes.concat([t.jSXAttribute(t.jSXIdentifier('is'), alternate)])
                ),
                t.jSXClosingElement(t.jSXIdentifier('Template')),
                [],
                true
              )
            )
          ),
        ]
        path.replaceWith(block)
      }
    }
    return
  }
  // @ts-ignore
  const { line, column } = path.node?.position?.start || { line: 0, column: 0 }
  const position = { col: column, row: line }
  throw new IReportError(
    'template 标签必须指名 `is` 或 `name` 任意一个标签',
    'TemplateMissingIsNameError',
    'WXML_FILE',
    astToCode(path.node) || '',
    position
  )
}

export function getWxmlSource (dirPath: string, src: string, type: string) {
  try {
    let filePath = join(dirPath, src)
    if (!extname(filePath)) {
      filePath = filePath + '.wxml'
    }
    const file = fs.readFileSync(filePath, 'utf-8')
    return file
  } catch (e) {
    errors.push(`找不到这个路径的 wxml: <${type} src="${src}" />，该标签将会被忽略掉`)
    return ''
  }
}

export function parseModule (jsx: NodePath<t.JSXElement>, dirPath: string, type: 'include' | 'import') {
  updateLogFileContent(
    `INFO [taroize] parseModule - 入参 ${getLineBreak()}jsx: ${jsx}, dirPath: ${dirPath} ${getLineBreak()}`
  )
  const openingElement = jsx.get('openingElement')
  const attrs = openingElement.get('attributes')
  // const src = attrs.find(attr => t.isJSXAttribute(attr) && t.isJSXIdentifier(attr.name) && attr.name.name === 'src')
  // Fix
  const src = attrs.find(
    (attr) =>
      t.isJSXAttribute(attr as any) &&
      t.isJSXIdentifier(attr!.get('name') as any) &&
      t.isJSXAttribute(attr.node) &&
      attr.node.name.name === 'src'
  )
  if (!src) {
    // @ts-ignore
    const { line, column } = jsx.node?.position?.start || { line: 0, column: 0 }
    const position = { col: column, row: line }
    updateLogFileContent(`ERROR [taroize] parseModule - ${type} 标签未包含 src 属性 ${getLineBreak()}`)
    throw new IReportError(
      `${type} 标签必须包含 \`src\` 属性`,
      'WxmlTagSrcAttributeError',
      'WXML_FILE',
      astToCode(jsx.node) || '',
      position
    )
  }
  if (extname(dirPath)) {
    dirPath = dirname(dirPath)
  }
  if (!t.isJSXAttribute(src.node)) {
    // @ts-ignore
    const { line, column } = jsx.node?.position?.start || { line: 0, column: 0 }
    const position = { col: column, row: line }
    updateLogFileContent(`ERROR [taroize] parseModule - ${type} 标签 src AST 节点未包含 node ${getLineBreak()}`)
    throw new IReportError(
      `${type} 标签 src AST 节点 必须包含 node`,
      'WxmlTagSrcAttributeError',
      'WXML_FILE',
      astToCode(jsx.node) || '',
      position
    )
  }
  const value = src.node.value
  if (!t.isStringLiteral(value)) {
    // @ts-ignore
    const { line, column } = jsx.node?.position?.start || { line: 0, column: 0 }
    const position = { col: column, row: line }
    updateLogFileContent(`ERROR [taroize] parseModule - ${type} 标签的 src 属性值不是一个字符串 ${getLineBreak()}`)
    throw new IReportError(
      `${type} 标签的 src 属性值必须是一个字符串`,
      'WxmlTagSrcAttributeError',
      'WXML_FILE',
      astToCode(jsx.node) || '',
      position
    )
  }
  let srcValue = value.value
  // 判断是否为绝对路径
  try {
    srcValue = getSrcRelPath(dirPath, srcValue)
  } catch (error) {
    // @ts-ignore
    const { line, column } = jsx.node?.position?.start || { line: 0, column: 0 }
    const position = { col: column, row: line }
    throw new IReportError(
      '相对路径解析失败',
      'ImportSrcPathFormatError',
      'WXML_FILE',
      astToCode(jsx.node) || '',
      position
    )
  }
  if (type === 'import') {
    const wxml = getWxmlSource(dirPath, srcValue, type)
    const { imports } = parseWXML(resolve(dirPath, srcValue), wxml, true)
    try {
      jsx.remove()
    } catch (error) {
      //
    }
    return imports
  } else {
    const wxmlStr = getWxmlSource(dirPath, srcValue, type)
    const block = buildBlockElement()
    if (wxmlStr === '') {
      if (jsx.node.children.length) {
        console.error(
          `标签：<include src="${srcValue}"> 没有自动关闭。形如：<include src="${srcValue}" /> 才是标准的 wxml 格式。`
        )
        updateLogFileContent(
          `WARN [taroize] parseModule - 标签：<include src="${srcValue}"> 没有自动关闭 ${getLineBreak()}`
        )
      }
      jsx.remove()
      return
    }
    const { wxml } = parseWXML(resolve(dirPath, srcValue), wxmlStr, true)
    try {
      if (wxml) {
        block.children = [wxml as any]
        jsx.replaceWith(wxml)
      } else {
        block.children = [t.jSXExpressionContainer(t.jSXEmptyExpression())]
        jsx.replaceWith(block)
      }
    } catch (error) {
      //
    }
  }
}
