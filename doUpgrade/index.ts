import { AzureFunction, Context, HttpRequest } from "@azure/functions"
import * as azure from 'azure-storage'
import { Octokit } from '@octokit/rest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as upgrade from 'ts-upgrade';
import * as uuid from 'uuid';
import git from 'isomorphic-git';
import * as http from 'isomorphic-git/http/node';

enum Status {
    error = -1,
    auth = 0,
    fork,
    clone,
    branch,
    checkout,
    upgrade,
    add,
    commit,
    push,
    star,
    pr,
    done
}

const entGen = azure.TableUtilities.entityGenerator;

export interface Options {
    authToken: string;
    connectionString: string;
    owner: string;
    repo: string;
    id?: string
    branch?: string;
    version?: upgrade.TypeScriptVersion
}

function createTableIfNotExists(tableService: azure.TableService, tableName: string) {
    return new Promise((resolve, reject) => {
        tableService.createTableIfNotExists(tableName, (error, result) => {
            if (error) {
                reject(error)
            } else {
                resolve(result)
            }
        })
    })
}

function insertOrReplaceEntity(tableService: azure.TableService, tableName: string, entry: unknown) {
    return new Promise((resolve, reject) => {
        tableService.insertOrReplaceEntity(tableName, entry, (error, result) => {
            if (error) {
                reject(error)
            } else {
                resolve(result)
            }
        })
    })
}

function insertOrMergeEntity(tableService: azure.TableService, tableName: string, entry: unknown) {
    return new Promise((resolve, reject) => {
        tableService.insertOrMergeEntity(tableName, entry, (error, result) => {
            if (error) {
                reject(error)
            } else {
                resolve(result)
            }
        })
    })
}

function insertOrMergeStatus(tableService: azure.TableService, tableName: string, id: string, owner: string, status: Status) {
    const entry = {
        RowKey: entGen.String(id),
        PartitionKey: entGen.String(owner),
        status: entGen.Int32(status),
        lastStatus: entGen.Int32(status)
    }
    return insertOrMergeEntity(tableService, tableName, entry)
}

function insertOrMergeStatusWithoutLast(tableService: azure.TableService, tableName: string, id: string, owner: string, status: Status) {
    const entry = {
        RowKey: entGen.String(id),
        PartitionKey: entGen.String(owner),
        status: entGen.Int32(status)
    }
    return insertOrMergeEntity(tableService, tableName, entry)
}

async function main(context: Context, options: Options) {
    const { id, authToken, connectionString, owner, repo, branch = 'master', version = upgrade.TypeScriptVersion.Latest } = options;
    const tableService = azure.createTableService(connectionString);
    const tableName = "upgradeProcess"

    if (id) {
        await createTableIfNotExists(tableService, tableName)

        const entry = {
            PartitionKey: entGen.String(owner),
            RowKey: entGen.String(id),
            owner: entGen.String(owner),
            repo: entGen.String(repo),
            branch: entGen.String(branch),
            version: entGen.Int32(version),
            status: entGen.Int32(Status.auth),
            lastStatus: entGen.Int32(Status.auth)
        }
        await insertOrReplaceEntity(tableService, tableName, entry)
    }
    try {

        const appOctokit = new Octokit({
            auth: authToken
        });
        context.log('Auth succeed');
        if (id) {
            await insertOrMergeStatus(tableService, tableName, id, owner, Status.fork)
        }

        const forkResult = await appOctokit.repos.createFork({
            owner,
            repo
        });
        context.log('Fork succeed');
        if (id) {
            await insertOrMergeStatus(tableService, tableName, id, owner, Status.clone)
        }

        const uid = uuid.v4();
        const tempPath = path.join(os.tmpdir(), uid);
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
        if (id) {
            await insertOrMergeStatus(tableService, tableName, id, owner, Status.branch)
        }

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
        if (id) {
            await insertOrMergeStatus(tableService, tableName, id, owner, Status.checkout)
        }

        await git.checkout({
            fs,
            dir,
            ref: branchName
        });
        context.log('checkout branch', branchName);
        if (id) {
            await insertOrMergeStatus(tableService, tableName, id, owner, Status.upgrade)
        }

        upgrade.upgradeFromProject(tempPath, version);
        context.log('upgrade succeed');
        if (id) {
            await insertOrMergeStatus(tableService, tableName, id, owner, Status.add)
        }

        await git.add({
            fs,
            dir,
            filepath: '.'
        });
        context.log('add changes succeed');
        if (id) {
            await insertOrMergeStatus(tableService, tableName, id, owner, Status.commit)
        }

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
        if (id) {
            await insertOrMergeStatus(tableService, tableName, id, owner, Status.push)
        }

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
        if (id) {
            await insertOrMergeStatus(tableService, tableName, id, owner, Status.star)
        }

        await appOctokit.activity.starRepoForAuthenticatedUser({
            owner,
            repo
        });
        context.log('star succeed');
        if (id) {
            await insertOrMergeStatus(tableService, tableName, id, owner, Status.pr)
        }

        const prResult = await appOctokit.pulls.create({
            owner,
            repo,
            title: 'Upgrade TypeScript syntax',
            base: branch,
            head: `ts-upgrade-bot:${branchName}`
        });
        context.log('pull request created');
        if (id) {
            await insertOrMergeStatus(tableService, tableName, id, owner, Status.done)
        }

        return prResult.data.url
    } catch (e) {
        if (id) {
            await insertOrMergeStatusWithoutLast(tableService, tableName, id, owner, Status.error)
        }
        throw e
    }
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
    const { id, owner, repo, branch, version } = body.options
    const authToken = process.env.GITHUB_AUTH_TOKEN
    const connectionString = process.env.AZURE_CONNECTION_STRING
    const timeout = parseInt(process.env.UPGRADE_TIMEOUT) || 3 * 60 * 1000

    const url = await worker(context, {
        authToken,
        connectionString,
        id,
        owner,
        repo,
        branch,
        version
    }, timeout)

    context.res.body = JSON.stringify({
        pr: url
    })
};

export default httpTrigger;