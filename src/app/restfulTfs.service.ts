import {Injectable} from "@angular/core";
import {Headers, Http, Response} from "@angular/http";

import {Observable} from "rxjs";
import "rxjs/Rx";

import {AppConfigService} from "./appConfig.service";
import {GitPullRequestWithStatuses, GitStatusState, PullRequestAsyncStatus, TfsService, User} from "./model";

@Injectable()
// Interacts with TFS REST APis.  Meant for use when not running in the context of a TFS extension (ie. development)
export class RestfulTfsService extends TfsService {

    private USER_HEADER_NAME: string  = "x-vss-userdata";
    // need to specify the version to get the response objects to look the same as when requested using the VSS Extension APIs
    private IDENTITIES_API_ACCEPT_HEADER: string = "application/json; api-version=2.3-preview.1";

    private baseUri: string;
    private currentProject: string;

    constructor(private http: Http, config: AppConfigService) {
        super();

        this.baseUri = config.devApiEndpoint;
        this.currentProject = config.devDefaultProject;
    }

    public async getCurrentUser(): Promise<User> {
        // just do a basic query to tfs to be able to look at response headers
        let r = await this.http.get(`${this.baseUri}/_apis/projects`, {withCredentials: true}).toPromise();
        // aren't actually interested in the projects response body, just the response headers.
        // tfs adds a header in the response with the current authenticated users id in the format <userid>:<username>
        const userIdHeader = r.headers.get(this.USER_HEADER_NAME);
        const headerRegex = /([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})/i;
        const match = headerRegex.exec(userIdHeader);
        const userId = match[1];

        r = await this.http.get(`${this.baseUri}/_apis/Identities/${userId}`, {
            withCredentials: true,
            headers: new Headers({Accept: this.IDENTITIES_API_ACCEPT_HEADER})
        }).toPromise();
        const userIdentity: Identity = r.json();
        const user: User = {
            id: userIdentity.id,
            displayName: userIdentity.customDisplayName,
            uniqueName: userIdentity.providerDisplayName,
            memberOf: []
        };

        const membersOf = await this.getMembersOf(userId);
        const promises: Array<Promise<Identity[]>> = [];
        for (const m of membersOf) {
            user.memberOf.push(m);
            // now recurse once into the subgroups of each group the member is a member of, to include
            // virtual groups made up of several groups
            promises.push(this.getMembersOf(m.id));
        }
        const subMembersOf = await Promise.all(promises);
        for (const members of subMembersOf) {
            for (const i of members) {
                user.memberOf.push(i);
            }
        }

        return user;
    }

    public getPullRequests(allProjects?: boolean): Observable<GitPullRequestWithStatuses> {
        let url = `${this.baseUri}/${this.currentProject}/_apis/git/pullRequests?status=active&$top=1000`;
        if (allProjects) {
            url = `${this.baseUri}/_apis/git/pullRequests?status=active&$top=1000`;
        }

        return this.http.get(url, {withCredentials: true})
            .map((r: Response) => this.extractData(r))
            .mergeMap((prs: GitPullRequest[]) => prs)
            .flatMap((pr) => this.getPullRequestComplete(pr))
            .flatMap((pr) => this.getPullRequestWithStatuses(pr))
            .map((pr: any) => {
                if (pr.mergeStatus) {
                    // the rest apis return a string for the mergestatus, but the VSS APIs convert that into
                    // an int.  Do the same here, so we can treat PRs the same throughout the app.
                    // note - we only care about conflicts for now, since we only show something different on merge conflicts.
                    if (pr.mergeStatus === "conflicts") {
                        pr.mergeStatus = PullRequestAsyncStatus.Conflicts;
                    } else {
                        pr.mergeStatus = PullRequestAsyncStatus.Succeeded;
                    }
                }
                return pr;
            });
    }

    public getRepositories(allProjects?: boolean): Promise<GitRepository[]> {
        let url = `${this.baseUri}/${this.currentProject}/_apis/git/repositories?includeLinks=true`;
        if (allProjects) {
            url = `${this.baseUri}/_apis/git/repositories?includeLinks=true`;
        }
        return this.http.get(url, {withCredentials: true})
            .toPromise()
            .then(this.extractData)
            .catch(this.handleError);
    }

    private getPullRequestComplete(pullRequest: GitPullRequest): Observable<GitPullRequest> {
        const url = `${this.baseUri}/_apis/git/repositories/${pullRequest.repository.id}/pullRequests/${pullRequest.pullRequestId}`;
        var pr = this.http.get(url, {withCredentials: true}).map((r: Response) => r.json());
        return pr.map((pr) => this.getPullRequestUnresolvedComments(pr));
    }

    private getPullRequestWithStatuses(pullRequest: GitPullRequest): Observable<GitPullRequestWithStatuses> {
        const url = `${this.baseUri}/_apis/git/repositories/${pullRequest.repository.id}/pullRequests/${pullRequest.pullRequestId}/statuses`;
        return this.http.get(url, {withCredentials: true})
            .map((r: Response) => {
                const res: any = {statuses: this.extractData(r)};
                // The convert the rest api status to the enum for consistency with the extensions api
                for (const status of res.statuses) {
                    const statusUpdate = {state: GitStatusState.Pending};
                    // pending statuses don't have a state set on them
                    if (status.state) {
                        if (status.state === "failed") {
                            statusUpdate.state = GitStatusState.Failed;
                        } else if (status.state === "succeeded") {
                            statusUpdate.state = GitStatusState.Succeeded;
                        }
                    }
                    Object.assign(status, statusUpdate);
                }
                Object.assign(res, pullRequest);
                return res;
            });
    }

    private getPullRequestUnresolvedComments(pullRequest: GitPullRequest): GitPullRequest {
        const url = `${this.baseUri}/_apis/git/repositories/${pullRequest.repository.id}/pullRequests/${pullRequest.pullRequestId}/threads`;
        const threads: any = this.http.get(url, {withCredentials: true}).map((r: Response) => r.json());
        var totalUnresolved = 0;
        for (const thread of threads){
            if (thread.status == "active"){
                totalUnresolved++;
            }
        }
        pullRequest.unresolvedComments = totalUnresolved;
        return pullRequest;
    }

    private async getMembersOf(userId: string): Promise<Identity[]> {
        const response = await (this.http.get(`${this.baseUri}/_apis/Identities/${userId}/membersOf`, {
            withCredentials: true,
            headers: new Headers({Accept: this.IDENTITIES_API_ACCEPT_HEADER})
        }).toPromise());
        const promises: Array<Promise<Response>> = [];
        const result: Identity[] = [];
        const memberOfIds: string[] = this.extractData(response);
        for (const memberId of memberOfIds) {
            // ignore any non-tfs identities
            if (!memberId.startsWith("Microsoft.TeamFoundation.Identity")) {
                continue;
            }

            promises.push(this.http.get(`${this.baseUri}/_apis/Identities/${memberId}`, {
                withCredentials: true,
                headers: new Headers({Accept: this.IDENTITIES_API_ACCEPT_HEADER})
            }).toPromise());
        }

        const responses = await Promise.all(promises);
        for (const r of responses) {
            result.push(r.json());
        }
        return result;
    }

    private extractData(res: Response): any {
        const body = res.json();
        return body.value || [];
    }

    private handleError(error: any) {
      const errMsg = (error.message) ? error.message :
        error.status ? `${error.status} - ${error.statusText}` : "Server error";
      console.error(errMsg); // log to console instead
      return Promise.reject(errMsg);
    }
}
