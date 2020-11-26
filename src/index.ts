import { getInput, error as emitError, debug, warning } from "@actions/core"
import { getOctokit, context } from "@actions/github"
import { execSync } from "child_process"
import { ESLint } from "eslint"
import * as fs from "fs"
import * as path from "path"

const options = {
  token: getInput("token"),
  fix: !!context.payload.pull_request,
  pr: context.payload.pull_request ? context.payload.pull_request.number : null,
  directory: process.cwd(),
  workspace: process.env.GITHUB_WORKSPACE || process.cwd(),
}

const octa = getOctokit(options.token)

function getBinaryUsing(
  packageManager: string,
  directory: string,
  name: string,
): string | null {
  const binaryDirectory = execSync(`${packageManager} bin`, { cwd: directory })
    .toString()
    .trim()
  const binary = path.resolve(binaryDirectory, name)

  try {
    execSync(`${binary} --version`)

    return binary
  } catch {
    return null
  }
}

function getBinary(directory: string, name: string) {
  const isFile = (file: string) => fs.existsSync(path.resolve(directory, file))

  if (isFile("pnpm-lock.yaml")) return getBinaryUsing("pnpm", directory, name)
  if (isFile("yarn.lock")) return getBinaryUsing("yarn", directory, name)
  return getBinaryUsing("npm", directory, name)
}

async function startCheck(name: string): Promise<number> {
  const response = await octa.checks.create({
    name,
    ...context.repo,
    head_sha: context.sha,
    status: "in_progress",
  })

  return response.data.id
}

function chunks<T>(items: T[], size: number = 50): T[][] {
  const chunks: T[][] = []
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, size))
  }

  return chunks
}

async function runESLint(args: string[]) {
  const eslint = getBinary(options.directory, "eslint")
  const id = await startCheck("ESLint")

  try {
    const results = getESLintResults(
      eslint!,
      args.filter((arg) => /\.(ts|tsx|vue)$/.test(arg)),
    )

    let errors = 0
    const annotations: any[] = []
    for (const result of results) {
      const fileName = path.relative(options.workspace, result.filePath)
      for (const message of result.messages) {
        if (message.fix && options.fix) continue
        if (message.severity === 2) ++errors

        annotations.push({
          path: fileName,
          start_line: message.line,
          start_column: message.column,
          end_line: message.endLine || message.line,
          end_columnn: message.endColumn || message.endColumn,
          annotation_level: message.severity === 2 ? "failure" : "warning",
          message: `[${message.ruleId}] ${message.message}`,
        })
      }
    }

    let index = 0
    const payloads = chunks(annotations)
    for (const payload of payloads) {
      await octa.checks.update({
        check_run_id: id,
        head_sha: context.sha,
        owner: context.repo.owner,
        repo: context.repo.repo,
        status: ++index === payloads.length ? "completed" : "in_progress",
        conclusion: errors ? "failure" : "success",
        output: {
          title: "ESLint",
          summary: `${errors} ${errors === 1 ? "error" : "errors"} found`,
          annotations: payload,
        },
      })
    }
  } catch (error) {
    emitError(error)
    await octa.checks.update({
      check_run_id: id,
      head_sha: context.sha,
      owner: context.repo.owner,
      repo: context.repo.repo,
      status: "completed",
      conclusion: "failure",
      output: {
        title: "ESLint",
        summary: `${error.message} ${error.stack}`,
      },
    })
  }

  const changes = getLocalChangedFiles(args)
  for (const fileName of changes) {
    const contents = fs.readFileSync(
      path.resolve(options.directory, fileName),
      { encoding: "utf-8" },
    )

    await updateFile(fileName, contents, "style(auto): eslint fix")
  }
}

async function updateFile(fileName: string, contents: string, message: string) {
  const file = await getFileFromBranch(fileName)

  if (file && file.data && file.data.content !== contents) {
    await octa.repos.createOrUpdateFileContents({
      ...context.repo,
      branch: process.env.GITHUB_HEAD_REF!,
      path: fileName,
      content: Buffer.from(contents).toString("base64"),
      message: `${message} ${fileName}`,
      sha: file.data.sha,
    })
  }
}

function getFileFromBranch(fileName: string) {
  return octa.repos.getContent({
    ...context.repo,
    ref: process.env.GITHUB_HEAD_REF!,
    path: fileName,
  })
}

function getESLintResults(eslint: string, args: string[]): ESLint.LintResult[] {
  if (!args.length) return []

  const output = execSync(
    `${eslint} --fix --no-color --quiet --format json ${asCLIArgs(args)}`,
    {
      cwd: options.directory,
    },
  ).toString()

  return JSON.parse(output) as ESLint.LintResult[]
}
function getLocalChangedFiles(files: string[]): string[] {
  const isChanged = new Set(files)

  return execSync("git diff --name-only", { cwd: options.directory })
    .toString()
    .split("\n")
    .map((fileName) => fileName.trim())
    .filter((fileName) => isChanged.has(fileName))
}
async function getChangedFiles(): Promise<string[]> {
  debug(`getChangedFiles`)

  if (!options.pr) {
    warning("This is not a PR. Skipping.")
    return []
  }

  const { owner, repo } = context.repo
  const config = octa.pulls.listFiles.endpoint.merge({
    owner,
    repo,
    pull_number: options.pr,
    per_page: 100,
    page: 1,
  })

  const files: Array<{
    filename: string
    status: string
  }> = await octa.paginate(config)
  files.forEach((file) => debug(`${file.filename} ${file.status}`))

  return files
    .filter((file) => file.status !== "removed")
    .map((file) => file.filename)
}

async function runPrettier(files: string[]) {
  const prettier = getBinary(options.directory, "prettier")
  const id = await startCheck("Prettier")
  try {
    execSync(`${prettier} --ignore-unknown --write ${asCLIArgs(files)}`, {
      cwd: options.directory,
      stdio: "inherit",
    })
    await octa.checks.update({
      check_run_id: id,
      head_sha: context.sha,
      owner: context.repo.owner,
      repo: context.repo.repo,
      status: "completed",
      conclusion: "success",
      output: {
        title: "ESLint",
        summary: ``,
      },
    })
  } catch (error) {
    await octa.checks.update({
      check_run_id: id,
      head_sha: context.sha,
      owner: context.repo.owner,
      repo: context.repo.repo,
      status: "completed",
      conclusion: "failure",
      output: {
        title: "ESLint",
        summary: `${error.message} ${error.stack}`,
      },
    })
  }

  const changes = getLocalChangedFiles(files)
  for (const fileName of changes) {
    const contents = fs.readFileSync(
      path.resolve(options.directory, fileName),
      { encoding: "utf-8" },
    )

    await updateFile(fileName, contents, "style(auto): prettier fix")
  }
}

function asCLIArgs(args: string[]): string {
  return args.map((arg) => JSON.stringify(arg)).join(" ")
}

async function main() {
  const files = await getChangedFiles()
  if (files.length) {
    await runESLint(files)
    await runPrettier(files)
  }
}

main()
