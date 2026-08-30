#!/usr/bin/env node
// Build the Telmi store JSON from the organisation repositories and publish it to a Gist.
// Replaces the former Deno Deploy cron job (Deno.cron is no longer offered by Deno Deploy).
//
// It also keeps a local, versioned copy of the store under store/, so the repository
// carries a readable history of what changed and when.
//
// Usage:
//   node .github/scripts/sync-store.mjs            # build, update store/, push to the Gist
//   node .github/scripts/sync-store.mjs --dry-run  # build and update store/, push nothing
//
// Environment:
//   GITHUB_TOKEN  optional, only used to raise the GitHub API rate limit
//   GIST_TOKEN    required unless --dry-run, a PAT with the "gist" scope

import { mkdir, readFile, writeFile } from 'node:fs/promises'

// ---------------------------------------------------------------------------
// Store configuration. This is the only part to adapt when reusing this script
// for another Telmi store.
// ---------------------------------------------------------------------------
const config = {
    org: 'telmi-store-en',
    gistId: 'c2da96666a3a84397f19576d94d15a57',
    gistFilename: 'telmi-interactive-en.json',
    // Keep a versioned copy of the store under store/ and commit it on every run.
    // This is also what keeps the scheduled workflow alive: GitHub disables it after
    // 60 days without repository activity, and the daily commit resets that timer.
    // Turning this off gives up both the history and that protection.
    history: true,
    banner: {
        image: 'https://raw.githubusercontent.com/telmi-store-en/.github/main/profile/banner-telmi.jpg',
        background: '#2e144b',
        link: 'https://discord.gg/ZTA5FyERbg'
    }
}
// ---------------------------------------------------------------------------

const DRY_RUN = process.argv.includes('--dry-run')

// Versioned copy of the store, committed by the workflow on every run.
const STORE_DIR = new URL('../../store/', import.meta.url)
const STORE_FILE = new URL(config.gistFilename, STORE_DIR)
const CHANGELOG_FILE = new URL('CHANGELOG.md', STORE_DIR)
const CHANGELOG_HEADER = '# Store history\n'

const apiHeaders = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'telmi-store-sync',
    ...(process.env.GITHUB_TOKEN ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {})
}

const warnings = []
const warn = (message) => {
    warnings.push(message)
    console.warn(`::warning::${message}`)
}

// Kept identical to the original Deno script so the generated JSON stays byte-comparable.
const strFormat = (str) => String(str ?? '').replace(/[^\u0020-\ucfbf\u000A]+/g, ' ').trim()

// The original script used the API defaults and silently ignored anything past the first page.
const apiPaginated = async (url) => {
    const results = []
    let next = `${url}${url.includes('?') ? '&' : '?'}per_page=100`
    while (next) {
        const res = await fetch(next, { headers: apiHeaders })
        if (!res.ok) {
            throw new Error(`GET ${next} -> ${res.status} ${res.statusText}`)
        }
        results.push(...(await res.json()))
        next = (res.headers.get('link') ?? '').match(/<([^>]+)>;\s*rel="next"/)?.[1] ?? null
    }
    return results
}

const imageExists = async (url) => {
    try {
        const res = await fetch(url, { method: 'HEAD' })
        return res.status === 200
    } catch {
        return false
    }
}

// Parse the "> key : value" lines of a release body; everything else is the description.
const parseReleaseBody = (body) => (body ?? '').replace(/\r/g, '').split('\n').reduce(
    (acc, line) => {
        if (line.substring(0, 1) !== '>') {
            acc.description = `${acc.description}\n${line}`
            return acc
        }
        const colonPos = line.indexOf(':', 1)
        if (colonPos === -1) {
            acc.description = `${acc.description}\n${line}`
            return acc
        }
        return {
            ...acc,
            [line.substring(1, colonPos).trim().toLowerCase()]: line.substring(colonPos + 1).trim()
        }
    },
    { description: '' }
)

// Turn one repository into a store entry, or return null with a warning when it is not a valid pack.
const repoToPack = async (repo) => {
    const thumbnail = `https://raw.githubusercontent.com/${repo.full_name}/${repo.default_branch}/thumbnail.jpg`
    if (!(await imageExists(thumbnail))) {
        return null // not a story pack repository, skip silently
    }

    const title = [...String(repo.description ?? '').matchAll(/^\[([0-9]+)\+](.*)\(([A-Z]+)\)$/g)]
    if (!title.length) {
        warn(`${repo.name}: repository description is missing or malformed, expected "[age+] Title (LANG)"`)
        return null
    }

    const releases = await apiPaginated(`${repo.url}/releases`)
    if (!releases.length || !releases[0].assets.length) {
        warn(`${repo.name}: no release with assets`)
        return null
    }

    const download = releases[0].assets.reduce(
        (acc, asset) => (asset.browser_download_url.endsWith('.zip') ? asset.browser_download_url : acc),
        ''
    )
    if (download === '') {
        warn(`${repo.name}: latest release has no .zip asset`)
        return null
    }

    const downloadCount = releases.reduce(
        (acc, release) => release.assets.reduce((sum, asset) => sum + asset.download_count, acc),
        0
    )
    const details = parseReleaseBody(releases[0].body)

    return Object.assign(
        {
            age: parseInt(strFormat(title[0][1]), 10),
            title: strFormat(title[0][2]),
            description: strFormat(details.description),
            thumbs: { small: thumbnail, medium: thumbnail },
            download: strFormat(download),
            download_count: downloadCount,
            awards: details.awards !== undefined
                ? details.awards.substring(1).split('#').map((v) => strFormat(v.trim()))
                : [],
            created_at: releases[releases.length - 1].published_at,
            updated_at: releases[0].published_at
        },
        details.uuid !== undefined ? { uuid: details.uuid } : null,
        details.author !== undefined ? { author: details.author } : null,
        details.voice !== undefined ? { voice: details.voice } : null,
        details.designer !== undefined ? { designer: details.designer } : null,
        details.publisher !== undefined ? { publisher: details.publisher } : null,
        details.category !== undefined ? { category: details.category } : null,
        details.version !== undefined ? { version: details.version } : null,
        details.license !== undefined ? { license: details.license } : null
    )
}

const ghOutput = async (line) => {
    if (process.env.GITHUB_OUTPUT) {
        await writeFile(process.env.GITHUB_OUTPUT, `${line}\n`, { flag: 'a' })
    }
}

// --- History -----------------------------------------------------------------

const readIfExists = async (url) => {
    try {
        return await readFile(url, 'utf8')
    } catch {
        return null
    }
}

// A pack is tracked by its uuid when it has one, by its title otherwise.
const packKey = (pack) => pack.uuid ?? pack.title

// Everything except the download counter: counters drift on their own and are not
// worth a history entry.
const packSignature = ({ download_count, ...rest }) => JSON.stringify(rest)

const diffStores = (previous, next) => {
    const before = new Map((previous?.data ?? []).map((p) => [packKey(p), p]))
    const after = new Map(next.data.map((p) => [packKey(p), p]))
    const changes = []

    for (const [key, pack] of after) {
        const old = before.get(key)
        if (!old) {
            changes.push({ kind: 'added', text: `Added **${pack.title}** (${pack.age}+)` })
        } else if (packSignature(old) !== packSignature(pack)) {
            changes.push({
                kind: 'updated',
                text: old.version !== pack.version
                    ? `Updated **${pack.title}** (version ${old.version ?? '?'} to ${pack.version ?? '?'})`
                    : `Updated **${pack.title}**`
            })
        }
    }
    for (const [key, pack] of before) {
        if (!after.has(key)) {
            changes.push({ kind: 'removed', text: `Removed **${pack.title}**` })
        }
    }
    if (previous && JSON.stringify(previous.banner) !== JSON.stringify(next.banner)) {
        changes.push({ kind: 'banner', text: 'Updated the store banner' })
    }
    return changes
}

// Newest entry first, so the file reads top-down like a changelog.
const prependChangelog = async (day, changes) => {
    const existing = (await readIfExists(CHANGELOG_FILE)) ?? ''
    const body = existing.startsWith(CHANGELOG_HEADER) ? existing.slice(CHANGELOG_HEADER.length) : existing
    const entry = `\n## ${day}\n\n${changes.map((c) => `- ${c.text}`).join('\n')}\n`
    await writeFile(CHANGELOG_FILE, `${CHANGELOG_HEADER}${entry}${body}`)
}

// Commit subject, kept short and free of pack titles.
const commitSubject = (changes, unchanged) => {
    if (!changes.length) {
        return unchanged ? 'Sync store: no change' : 'Sync store: refresh download counters'
    }
    const count = (kind) => changes.filter((c) => c.kind === kind).length
    const parts = [
        count('added') && `${count('added')} added`,
        count('updated') && `${count('updated')} updated`,
        count('removed') && `${count('removed')} removed`,
        count('banner') && 'banner updated'
    ].filter(Boolean)
    return `Sync store: ${parts.join(', ')}`
}

const repos = await apiPaginated(`https://api.github.com/orgs/${config.org}/repos`)
console.log(`Found ${repos.length} repositories in ${config.org}`)

const data = []
for (const repo of repos) {
    try {
        const pack = await repoToPack(repo)
        if (pack) {
            data.push(pack)
            console.log(`  + ${pack.age}+ ${pack.title} (${pack.download_count} downloads)`)
        }
    } catch (error) {
        // One broken pack must never take the whole store down.
        warn(`${repo.name}: skipped after an error (${error.message})`)
    }
}

if (!data.length) {
    console.error('::error::No valid story pack found, refusing to publish an empty store')
    process.exit(1)
}

const store = { banner: config.banner, data }
const payload = JSON.stringify(store)
const [day, time] = new Date().toISOString().split('T')

// --- Update the versioned copy ----------------------------------------------

let changes = []
if (config.history) {
    const previous = JSON.parse((await readIfExists(STORE_FILE)) ?? 'null')
    changes = diffStores(previous, store)
    const unchanged = previous !== null && JSON.stringify(previous) === payload

    await mkdir(STORE_DIR, { recursive: true })
    await writeFile(STORE_FILE, `${JSON.stringify(store, null, 2)}\n`)
    if (changes.length) {
        await prependChangelog(day, changes)
    }

    const subject = commitSubject(changes, unchanged)
    console.log(subject)
    for (const change of changes) {
        console.log(`  ${change.text.replace(/\*\*/g, '')}`)
    }
    await ghOutput(`commit_message=${subject}`)
} else {
    console.log('History disabled: no local snapshot kept, and no protection against')
    console.log('the 60-day inactivity cutoff that disables scheduled workflows.')
}

// Read by the workflow to decide whether to commit.
await ghOutput(`history=${config.history}`)

// --- Publish ------------------------------------------------------------------

if (DRY_RUN) {
    console.log(`Dry run: ${data.length} pack(s), ${payload.length} bytes, nothing pushed`)
    process.exit(0)
}

const gistToken = process.env.GIST_TOKEN
if (!gistToken) {
    console.error('::error::GIST_TOKEN is not set')
    process.exit(1)
}

const res = await fetch(`https://api.github.com/gists/${config.gistId}`, {
    method: 'PATCH',
    headers: {
        Authorization: `Bearer ${gistToken}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'telmi-store-sync'
    },
    body: JSON.stringify({
        description: `Update ${config.org} (${day} ${time.substring(0, 8)})`,
        files: { [config.gistFilename]: { content: payload } }
    })
})

if (!res.ok) {
    console.error(`::error::Gist update failed: ${res.status} ${res.statusText} ${await res.text()}`)
    process.exit(1)
}

console.log(`Published ${data.length} pack(s) to gist ${config.gistId}/${config.gistFilename}`)

const summary = process.env.GITHUB_STEP_SUMMARY
if (summary) {
    const lines = [
        `### Telmi store \`${config.org}\``,
        '',
        `**${data.length}** pack(s) published to [\`${config.gistFilename}\`](https://gist.github.com/${config.gistId})`,
        '',
        ...(changes.length ? ['**Changes**', '', ...changes.map((c) => `- ${c.text}`), ''] : []),
        '| Age | Title | Version | Downloads | Updated |',
        '| --- | --- | --- | --- | --- |',
        ...data.map((p) => `| ${p.age}+ | ${p.title} | ${p.version ?? '-'} | ${p.download_count} | ${p.updated_at} |`),
        ...(warnings.length ? ['', '### Warnings', '', ...warnings.map((w) => `- ${w}`)] : [])
    ]
    await writeFile(summary, `${lines.join('\n')}\n`, { flag: 'a' })
}
