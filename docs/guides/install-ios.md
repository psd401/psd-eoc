# Install PSD EOC on iPhone or iPad

> **Distribution status: BLOCKED.** No installable PSD EOC TestFlight build or
> approved invitation has been verified yet. These illustrated screen
> references are advance guidance, not provider screenshots or install proof.
> Do not try to install until District Technology announces availability.

PSD EOC is distributed privately to approved Peninsula School District staff
through Apple TestFlight. Installing the app does not start an incident, run a
drill, or notify anyone.

> **Before you begin:** You need an approved TestFlight invitation from
> District Technology, your district staff sign-in, a device passcode, and
> internet access. Do not forward the invitation.

## Install the app

1. Install **TestFlight** from Apple's App Store if it is not already on your
   device.
2. Open the PSD EOC invitation sent through the approved district channel.
3. Confirm that the invitation says **PSD EOC** and comes from Peninsula School
   District's approved Apple account. If either is wrong, stop and contact
   District Technology.
4. Tap **View in TestFlight**, **Accept**, then **Install**. Apple's wording can
   vary slightly.
5. Open **PSD EOC** and sign in with your approved `@psd401.net` staff account.
6. Follow the app's prompt to enroll this device and enable Face ID, Touch ID,
   or the device's secure unlock. PSD EOC does not create or store a separate
   PIN.

![Three screen references showing the approved invitation, TestFlight acceptance, and PSD EOC installation](assets/issue-33/ios-testflight-install.svg)

TestFlight builds expire. If TestFlight shows **Build Removed**, **Expired**, or
no Install button, do not use an old copy or another person's invitation.
Contact District Technology for the approved current build.

## Allow notifications

When PSD EOC asks to send notifications, tap **Allow**. If you previously chose
Don't Allow:

1. Open **Settings → Notifications → PSD EOC**.
2. Turn on **Allow Notifications**.
3. Choose **Immediate Delivery**, and enable **Lock Screen**, **Notification
   Center**, **Banners**, and **Sounds**.
4. If **Time Sensitive Notifications** appears, turn it on. If the row does not
   appear, the installed build has not exposed that feature; contact District
   Technology and do not assume Focus can be bypassed.

PSD EOC uses ordinary notification entitlement at launch. It does **not** have
Apple's Critical Alerts entitlement. Time Sensitive notifications can break
through some Focus settings when both the app and Focus allow them, but they do
not guarantee sound when the device is muted or restricted by device policy.

## Check Focus settings

Repeat these steps for every Focus you use, including Do Not Disturb and Sleep:

1. Open **Settings → Focus →** the Focus name.
2. Under **Allow Notifications**, open **Apps**.
3. Choose **Allow Notifications From**, tap **Add Apps**, and select **PSD
   EOC**.
4. If shown, turn on **Time Sensitive Notifications** for that Focus.

![Two screen references showing PSD EOC notification and Focus settings](assets/issue-33/ios-notifications-focus.svg)

## Verify the installation safely

Do not start an incident or drill just to test installation. Use only a
district-approved synthetic test window. Scheduling the window does not
authorize or trigger a send. At test time, an authenticated human must freshly
review the synthetic targets and consequence preview, obtain explicit
product-owner authorization, confirm the action, and launch the synthetic test:

- Open PSD EOC and confirm your expected staff name and authorized site list.
- Lock the device before the scheduled test.
- After the test, report whether the alert appeared, made a sound, and opened
  the correct **TEST ONLY** event. Provider acceptance or a visible push is not
  proof that every person received it.
- If no alert appears, leave the app installed and contact District Technology.
  Include your iOS version and PSD EOC build number from TestFlight. Do not send
  screenshots containing message content, staff identities, device tokens, or
  other recipient data through an unapproved channel.

## Get help or remove access

Contact District Technology through the district's normal support channel if
you change devices, lose a device, leave the approved group, cannot unlock the
app, or see an unexpected site. They can revoke the old device session. Deleting
the app alone does not prove that the server-side session was revoked.
