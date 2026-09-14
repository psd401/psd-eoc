# App store review account

Apple and Google reviewers need to sign in to the mobile app and run a drill.
Staff sign-in is a Google account in a trusted group, and every drill reaches
the roster of the school it is started at, so the reviewer needs an account
that is real to Google, admitted by the app, and able to page nobody but
itself. This procedure builds that account once; it is not a release step.

Current environment, provider, and mobile state live in the
[operational readiness register](../INTEGRATIONS.md); this procedure never
restates them.

Nothing here writes a password, a backup code, or a store form. Those stay
with the person who owns the review account and are pasted by that person into
App Store Connect and the Play Console, never into this repository, an issue,
a chat, or a build.

## What the pieces are

| Piece                                                        | Where                        | Why                                                                                                                                                        |
| ------------------------------------------------------------ | ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A dedicated Google account                                   | Google Workspace             | The reviewer signs in with it. A named person's account is never lent.                                                                                     |
| The address admitted on the **Access** page                  | **Access** page              | Admission is what lets the account sign in, as staff, without being in any Google group. It is revocable in the same place and never grants administrator. |
| An **isolated** facility                                     | `psdEoc:facilities` manifest | An isolated facility's events reach its own building source only, never the district's others lists, so a reviewer's drill pages no responder.             |
| A building source at that facility naming the review account | **Facilities** page          | The drill's audience is the facility's building sources; this one holds exactly the review account.                                                        |
| The account limited to that facility                         | **Access** page              | Even with a district-wide roster, the reviewer can then see, start, and join events only at the review facility.                                           |

## Procedure

1. **Google.** Create the review account. Turn off 2-Step Verification
   enforcement for that account or issue it static backup codes; a reviewer
   cannot answer a live second factor. No group is needed.
2. **Manifest.** Add the review facility to `psdEoc:facilities` with
   `"isolated": true` and deploy. Bootstrap creates it; a later deploy never
   edits it. (It may also be added on the **Facilities** page with the
   **Isolated** box ticked.)
3. **Access.** Under **Admitted accounts**, admit the review account's
   address with a note saying what it is for. It may sign in as staff from
   then on; nothing else on the page changes.
4. **Facilities.** At the review facility add a manual building source and
   put the review account's address in it. Saving the people publishes the
   roster.
5. **First sign-in.** Sign in once as the review account in the app on a
   district phone, so the account exists and has a device registered for
   push, then on **Facilities** press **Publish roster snapshot** so that
   device is in the roster. Keep that phone signed in: an event cannot be
   started at a site whose roster holds no push device, and the reviewer's
   own device is only in the roster after the next publish. Sign-in is what
   creates the account's staff record; there is no way to configure a person
   who has never signed in.
6. **Access.** Open the account's row, **Limit to facilities**, choose the
   review facility only, and save. The limit applies to the account's next
   request.
7. **Prove it.** Signed in as the review account, start a drill preview at
   the review facility and read the audience: it must name one staff
   recipient and nobody else, with no others source in the plan, and the
   preview must not say notifications are not ready. Then confirm one drill
   and end it, so the reviewer's path has been walked once by a person.
8. **Store forms.** The account owner enters the sign-in address and its
   secret into App Store Connect's review information and the Play Console's
   app access instructions, together with the instructions below.

## Instructions for the reviewer

Use the text below in both consoles, filling in the address from the account
owner and the review facility's name.

> This app is for school district staff. Sign in with the Google account
> supplied here; there is no in-app registration. On the home screen choose
> **Start a drill**, pick the facility named _App Review_, choose any threat
> and response, and confirm. The drill notifies only this review account. End
> the drill from the event screen when finished. Real incidents require a
> district staff account and cannot be started with this one.

## Rotation and removal

- To remove access, revoke the admission on **Access**. The next sign-in
  is refused, the account's sessions stop authorizing on their next request,
  and the revoked admission stays listed as the record.
- To rotate the secret, change it in Google and update both store consoles;
  nothing in the app or repository holds it.
- Never widen the account to district-wide, and never move the isolated flag
  off the review facility: the guard against paging the district is those two
  settings.
- Never put the review account in a group that grants **admin**. Admission
  grants staff only, and an administrator is district-wide by definition and
  cannot be limited, so the limit would be refused. If it happens anyway,
  every administration page refuses the account until another administrator
  sets it district-wide on **Access** or it leaves the group.
