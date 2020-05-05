import { AzureFunction, Context, HttpRequest } from "@azure/functions"
import * as azure from 'azure-storage'

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

interface Task {
    RowKey: string
    owner: string
    repo: string
    branch: string
    status: Status
    lastStatus: Status
}

function queryEntities(tableService: azure.TableService, tableName: string, query: azure.TableQuery) {
    return new Promise<azure.TableService.QueryEntitiesResult<Task>>((resolve, reject) => {
        tableService.queryEntities<Task>(tableName, query, null, {
            payloadFormat: azure.TableUtilities.PayloadFormat.NO_METADATA
        }, (error, result) => {
            if (error) {
                reject(error)
            } else {
                resolve(result)
            }
        })
    })
}

const httpTrigger: AzureFunction = async function (context: Context, req: HttpRequest): Promise<void> {
    const id = req.body.id
    const connectionString = process.env.AZURE_CONNECTION_STRING
    const tableName = process.env.TASK_TABLE_NAME
    const tableService = azure.createTableService(connectionString)

    const idFilter = azure.TableQuery.stringFilter("RowKey", azure.TableUtilities.QueryComparisons.EQUAL, id)
    const query = new azure.TableQuery().where(idFilter)
    const result = await queryEntities(tableService, tableName, query);

    context.res.body = {
        data: result.entries && result.entries.length && result.entries[0] || undefined
    };
};

export default httpTrigger;