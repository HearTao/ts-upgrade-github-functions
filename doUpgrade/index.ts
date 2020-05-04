import { AzureFunction, Context, HttpRequest } from "@azure/functions"
import { Octokit } from '@octokit/rest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as upgrade from 'ts-upgrade';
import * as uuid from 'uuid';
import git from 'isomorphic-git';
import * as http from 'isomorphic-git/http/node';

export interface Options {
    authToken: string;
    owner: string;
    repo: string;
    branch?: string;
}

async function main(context: Context, options: Options) {
    const { authToken, owner, repo, branch = 'master' } = options;
    const appOctokit = new Octokit({
        auth: authToken
    });
    context.log('Auth succeed');

    const forkResult = await appOctokit.repos.createFork({
        owner,
        repo
    });
    context.log('Fork succeed');

    const id = uuid.v4();
    const tempPath = path.join(os.tmpdir(), id);
    const dir = tempPath;
    context.log(`clone ${forkResult.data.html_url} into ${tempPath} started`);

    await git.clone({
        fs,
        http,
        dir,
        url: forkResult.data.clone_url,
        singleBranch: true,
        depth: 1
    });
    context.log(`clone ${forkResult.data.html_url} into ${tempPath} succeed`);

    if (branch) {
        await git.checkout({
            fs,
            dir,
            ref: branch
        });
        context.log('checkout into', branch);
    }

    const commits = await git.log({
        fs,
        dir,
        depth: 1,
        ref: branch
    });
    const sha = commits[0]?.commit.tree;
    context.log(`current commit is`, sha);

    const branchName = `ts-upgrade-at-${sha.slice(0, 8)}`;

    await git.branch({
        fs,
        dir,
        ref: branchName
    });
    context.log('create branch', branchName);

    await git.checkout({
        fs,
        dir,
        ref: branchName
    });
    context.log('checkout branch', branchName);

    upgrade.upgradeFromProject(tempPath, upgrade.TypeScriptVersion.v3_8);
    context.log('upgrade succeed');

    await git.add({
        fs,
        dir,
        filepath: '.'
    });
    context.log('add changes succeed');

    await git.commit({
        fs,
        dir,
        author: {
            name: 'ts-upgrade-bot',
            email: 'tsupgradebot@gmail.com'
        },
        message: 'Upgrade TypeScript syntax'
    });
    context.log('commit succeed');

    await git.push({
        fs,
        http,
        dir,
        remote: 'origin',
        ref: branchName,
        force: true,
        onAuth: () => ({ username: authToken })
    });
    context.log('push succeed');

    const prResult = await appOctokit.pulls.create({
        owner,
        repo,
        title: 'Upgrade TypeScript syntax',
        base: branch,
        head: `ts-upgrade-bot:${branchName}`
    });
    context.log('pull request created');

    return prResult.data.url
}

function sleep(timeout: number) {
    return new Promise<void>(resolve => {
        setTimeout(() => {
            resolve();
        }, timeout);
    });
}

function worker(context: Context, options: Options, timeout: number) {
    return Promise.race([main(context, options), sleep(timeout)]);
}

const httpTrigger: AzureFunction = async function (context: Context, req: HttpRequest): Promise<void> {
    context.log('HTTP trigger function processed a request.');

    const body = req.body
    const { owner, repo, branch } = body.options
    const authToken = process.env.GITHUB_AUTH_TOKEN
    const timeout = parseInt(process.env.UPGRADE_TIMEOUT) || 3 * 60 * 1000
    
    const url = await worker(context, {
        authToken,
        owner,
        repo,
        branch
    }, timeout)

    context.res.body = JSON.stringify({
        pr: url
    })
};

export default httpTrigger;