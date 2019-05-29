import {Injectable, NgZone} from "@angular/core";
import { Observable } from "rxjs";

import {TfsService, User} from "./model";

// TfsService implementation which uses the VSS extension apis for fetching data
@Injectable()
export class ExtensionsApiTfsService extends TfsService {

    constructor(private gitClient: GitClient,
                private identitiesClient: IdentitiesClient,
                private coreTfsClient: CoreHttpClient,
                private isHosted: boolean,
                private projectName: string,
                private userContext: UserContext,
                private zone: NgZone) {

        super();
    }

    public async getCurrentUser(): Promise<User> {
        const user: User = {
            id: this.userContext.id,
            displayName: this.userContext.name,
            uniqueName: this.userContext.uniqueName,
            memberOf: []
        };
        // The identity apis aren't available in Visual Studio Team Services, only for Team Foundation Services.
        // If this is running as an extension in VSTS, we aren't able to return any group membership information for the current user.
        if (this.isHosted) {
            return user;
        }

        const membersOf = await this.getMembersOf(user.id);
        const promises: Array<Promise<Identity[]>> = [];
        for (const m of membersOf) {
            user.memberOf.push(m);
            // now recurse once into the subgroups of each group the member is a member of, to include
            // virtual groups made up of several groups
            promises.push(this.getMembersOf(m.id));
        }
        const subMembersOf = await Promise.all<Identity[]>(promises);
        for (const members of subMembersOf) {
            for (const i of members) {
                user.memberOf.push(i);
            }
        }
        return new Promise<User>((resolve, reject) => {
            // use ngzone to bring promise callback back into the angular zone
            this.zone.run(() => resolve(user));
        });
    }

    public getPullRequests(allProjects?: boolean): Observable<GitPullRequest> {
        return null;
        /*const project = (allProjects) ? null : this.projectName;
        const prPromises: Array<Promise<GitPullRequest[]>> = [];
        let projects: string[] = [this.projectName];

        if (allProjects) {
            projects = (await this.coreTfsClient.getProjects()).map((x) => x.name);
        }

        for (const proj of projects) {
            prPromises.push(this.gitClient.getPullRequestsByProject(proj, {
                                                includeLinks: true,
                                                creatorId: null,
                                                repositoryId: null,
                                                reviewerId: null,
                                                sourceRefName: null,
                                                status: 1,
                                                targetRefName: null},
                                            null,
                                            0,
                                            1000));
        }

        const allPrs = await Promise.all(prPromises);

        return new Promise<GitPullRequest[]>((resolve, reject) => {
            const all = ([].concat.apply([], allPrs));
            // use ngzone to bring promise callback back into the angular zone
            this.zone.run(() => resolve(all));
        });*/
    }

    public async getRepositories(allProjects?: boolean): Promise<GitRepository[]> {
        const repos = await this.gitClient.getRepositories(allProjects ? null : this.projectName, true);
        return new Promise<GitRepository[]>((resolve, reject) => {
            // use ngzone to bring promise callback back into the angular zone
            this.zone.run(() => resolve(repos));
        });
    }

    private async getMembersOf(userId: string): Promise<Identity[]> {
        // get the identities that the current user is a member of
        const members = await this.identitiesClient.readMembersOf(userId);
        const promises: Array<Promise<Identity>> = [];
        for (const memberId of members) {
            // ignore any non-tfs identities
            if (!memberId.startsWith("Microsoft.TeamFoundation.Identity")) {
                continue;
            }

            promises.push(this.identitiesClient.readIdentity(memberId));
        }
        const identities = await Promise.all(promises);
        return identities;
    }
}
