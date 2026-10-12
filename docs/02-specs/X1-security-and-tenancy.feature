# Spec for X1: security, tenancy and audit (cross-cutting; inherited by P1-P4).
# Problem statement: ../01-discovery/X1-security-and-tenancy.md
# Terms: glossary.md. Policies: policy-register.md.
#
# Tags: @X1-Snn is the scenario's stable ID; @need-X1-Nn is the need it serves; @POL-nn a
# policy it depends on. Conformance (design, tests, status) is kept in conformance.md.

Feature: Security, tenancy and audit

  As a buyer or agent operator
  I want my reservations, requests, keys and money reachable only by my account and my keys
  So that nobody else can see, book against or spend from my account

  As a supplier
  I want to see my own links and settlements, and nobody else's, and to be the only one who changes my links
  So that the marketplace stays neutral between competitors

  As Share finance and compliance
  I want every change to money, capacity, links or keys attributed to a principal, and operator power controlled
  So that every change can be explained and nobody can act unaccountably

  Rule: Every operation is performed by an authenticated principal

    @X1-S01 @need-X1-N1
    Scenario Outline: An unauthenticated request changes nothing and reveals nothing
      When an unauthenticated caller tries to <operation>
      Then <answer>
      And nothing changes and nothing about any account is revealed

      Examples:
        | operation                           | answer                                                   |
        | book a route                        | the submission is not accepted as unauthenticated        |
        | ask for a booking request's status  | the submission is not accepted as unauthenticated        |
        | cancel a reservation                | the request is refused as unauthenticated                |
        | ask for a balance                   | the request is refused as unauthenticated                |
        | ask for a statement                 | the request is refused as unauthenticated                |
        | issue an agent key                  | the request is refused as unauthenticated                |

  Rule: A principal sees and changes only its own account's data

    Background:
      Given buyer accounts "b1" and "b2"

    @X1-S02 @need-X1-N2 @POL-18 @POL-25
    Scenario Outline: Another account's data cannot be read, and its existence is not revealed
      When a principal of "b2" asks for <item> of "b1"
      Then the answer is the same as for <item> of an account that does not exist

      Examples:
        | item                        |
        | a reservation               |
        | a booking request           |
        | the balance                 |
        | the headroom                |
        | an agent key                |
        | an agent key's headroom     |
        | a statement                 |

    @X1-S03 @need-X1-N2
    Scenario Outline: Another account's reservation cannot be changed
      Given "b1" holds a confirmed reservation R
      When a principal of "b2" tries to <change> R
      Then the request is refused as if R did not exist
      And R is unchanged

      Examples:
        | change          |
        | cancel          |
        | shorten         |
        | extend          |
        | change the rate |

    @X1-S04 @need-X1-N2
    Scenario: A supplier sees only its own links and settlements
      Given suppliers "s1" and "s2", each with its own links
      When a principal of "s2" asks for the schedule of a link of "s1" or for the statement of "s1"
      Then the answer is the same as for a link or statement that does not exist

    @X1-S28 @need-X1-N2 @POL-33 @POL-32
    Scenario Outline: A supplier sees the reservations on its link, but not who holds them
      Given buyer "b1" holds a confirmed reservation R on a link of supplier "s1"
      When a principal of "s1" asks for the schedule of that link <when>
      Then it shows R's rate, window and endpoints, which are R's termination points on that link of "s1", never the route's ends, and a reference to R that is used for no other reservation
      And it shows <identity>

      Examples:
        | when                                                   | identity                                                              |
        | when "b1" has not consented and no legal order applies | nothing that identifies "b1" or links R to "b1"'s other reservations |
        | after an account administrator of "b1" consented to identify "b1" to "s1" | "b1"'s account identity                            |
        | after a compliance disclosure under a legal order that requires it (X1-S12) | "b1"'s account identity, recorded with the order |

    @X1-S30 @need-X1-N2 @need-X1-N8 @POL-33
    Scenario: Withdrawn consent stops the supplier seeing the buyer's identity from then on
      Given buyer "b1" holds a confirmed reservation R on a link of supplier "s1"
      And an account administrator of "b1" consented to identify "b1" to "s1"
      When the administrator withdraws that consent
      Then every later view by "s1" of that link's schedule shows nothing that identifies "b1"
      And a reservation of "b1" on a link of "s1" confirmed after the withdrawal is shown with nothing that links it to "b1" or to R (POL-33)
      And R keeps the reference "s1" already saw, which provisioning depends on
      And the withdrawal is recorded with the administrator and the time

    @X1-S24 @need-X1-N2 @POL-04
    Scenario: A webhook goes only to its own account's endpoint and carries nothing about another account
      Given "b1" and "b2" have each registered a webhook endpoint
      When the outcome of a booking request of "b1" is known
      Then it is sent only to the endpoint "b1" registered
      And it carries nothing about "b2" or any other account

  Rule: An agent key acts only for its account, and every credential stops working within 60 s of its revocation

    @X1-S05 @need-X1-N3 @POL-25
    Scenario: An agent key acts only for the account that issued it
      Given an agent key issued by account "b1"
      When the key tries to book or read on behalf of account "b2"
      Then a booking submission is not accepted, a read is refused, and nothing changes

    @X1-S06 @need-X1-N3 @POL-25
    Scenario: A revoked agent key is refused within 60 s of its revocation
      Given an account administrator of "b1" revoked one of its agent keys at 10:00:00
      When the key is used for any operation from 10:01:00
      Then a booking or status submission is not accepted, and any other request is refused, as unauthenticated

    @X1-S07 @need-X1-N3 @need-X1-N8 @POL-25
    Scenario: An operation by an agent key records the key
      When an agent key of "b1" books, changes or cancels a reservation
      Then the change records the key that made it, as well as the account

    @X1-S41 @need-X1-N3
    Scenario Outline: Every credential is refused within 60 s of its revocation
      Given <credential> was revoked at 10:00:00, <how>
      When it is used for any operation from 10:01:00
      Then the operation is not accepted, and nothing changes, as for an unauthenticated request

      Examples:
        | credential                               | how                                                              |
        | a session of user "u1" of account "b1"   | an account administrator of "b1" having removed "u1" from "b1"   |
        | a session of user "u1" of account "b1"   | "u1" having ended it                                             |
        | a session of user "v1" of supplier "s1"  | a supplier administrator of "s1" having removed "v1" from "s1"   |
        | the credential of an exporter of "s1"    | a supplier administrator of "s1" having revoked it               |

  Rule: Only an account administrator manages agent keys and their limits

    @X1-S18 @need-X1-N9 @POL-25 @POL-33 @POL-32
    Scenario Outline: An account administrator manages keys and their limits, users, administrator rights, webhook endpoints and consent
      Given an account administrator of "b1"
      When the administrator <action>
      Then the change takes effect

      Examples:
        | action                                                     |
        | issues an agent key                                        |
        | raises an agent key's `key_spend_limit`                    |
        | lowers an agent key's `key_inflight_limit`                 |
        | revokes an agent key                                       |
        | consents to identify the account to a named supplier       |
        | withdraws that consent                                     |
        | adds a user to the account                                 |
        | grants the account administrator right to another user     |
        | registers a webhook endpoint for the account (POL-32)      |

    @X1-S19 @need-X1-N9 @POL-25
    Scenario Outline: An agent key cannot manage keys or limits, its own or another's
      Given an agent key K of "b1"
      When K tries to <action>
      Then the request is refused and nothing changes
      And the attempt is recorded

      Examples:
        | action                                         |
        | raise its own `key_spend_limit`                |
        | raise its own `key_inflight_limit`             |
        | change another key's limits                    |
        | issue a new agent key                          |
        | revoke another agent key                       |
        | register a webhook endpoint                    |
        | grant the account administrator right to a user |

    @X1-S29 @need-X1-N9 @need-X1-N2 @POL-25 @POL-33
    Scenario Outline: Only an account administrator can consent to identify the account to a supplier
      Given buyer "b1" holds a confirmed reservation R on a link of supplier "s1"
      And a principal of "b1" that is <principal>
      When that principal tries to consent to identify "b1" to "s1"
      Then the request is refused and no consent is recorded
      And the attempt is recorded
      And the schedule of that link, asked for by a principal of "s1", shows nothing that identifies "b1" or links R to "b1"'s other reservations

      Examples:
        | principal                                         |
        | an agent key                                      |
        | a user without the account administrator right    |

    @X1-S25 @need-X1-N9 @POL-25
    Scenario Outline: An account user who is not an account administrator cannot manage keys or limits
      Given a user of "b1" without the account administrator right
      When the user tries to <action>
      Then the request is refused and nothing changes
      And the attempt is recorded

      Examples:
        | action                                  |
        | issue an agent key                      |
        | raise an agent key's `key_spend_limit`  |
        | revoke an agent key                     |
        | register a webhook endpoint             |
        | grant itself the account administrator right |

    @X1-S20 @need-X1-N9 @need-X1-N8 @POL-25 @POL-19
    Scenario: Every change to an agent key or its limits records who made it and when
      When an account administrator issues, changes or revokes an agent key, or changes its limits
      Then the change records the administrator, the time, and the old and new values

    @X1-S33 @need-X1-N9 @POL-32
    Scenario Outline: Only a supplier administrator manages the supplier's users, credentials and endpoints
      Given supplier "s1"
      When <principal> tries to <action> of "s1"
      Then <result>

      Examples:
        | principal                                        | action                                    | result                                               |
        | a supplier administrator of "s1"                 | add a user                                | it takes effect, recorded with the administrator (POL-32) |
        | a supplier administrator of "s1"                 | issue a credential for an exporter        | it takes effect, recorded with the administrator     |
        | a user of "s1" without the administrator right   | issue a credential for an exporter        | it is refused, nothing changes, and the attempt is recorded |
        | a principal of supplier "s2"                     | register a webhook endpoint               | it is refused as if "s1" did not exist               |

    @X1-S38 @need-X1-N9 @POL-32
    Scenario: An account always keeps at least one account administrator
      Given account "b1" has exactly one account administrator
      When that administrator removes its own administrator right
      Then the request is refused, stating that an account keeps at least one administrator, and nothing changes

    @X1-S40 @need-X1-N9 @POL-32 @POL-25 @POL-33
    Scenario Outline: An account none of whose administrators can act is recovered only by onboarding, and an existing administrator can object for recovery_hold
      Given the only account administrator of "b1", "u1", has lost its means of authentication
      And onboarding re-verified "b1"'s business and granted the administrator right to user "u2" of "b1" at 10:00, every user of "b1" being told at once (POL-32)
      When <event>
      Then <result>

      Examples:
        | event                                                                                              | result                                                                                                  |
        | "u2" removes "u1" from "b1" at 11:00                                                               | it is refused, the recovery being within `recovery_hold` (POL-32: 24 h), and nothing changes            |
        | "u2" issues an agent key, registers a webhook endpoint or gives consent to identify "b1" to a supplier at 11:00 | it is refused, the recovery being within `recovery_hold`, and nothing changes                 |
        | "u2" adds a user to "b1" at 11:00                                                                  | it takes effect, recorded with "u2"                                                                     |
        | "u1", having regained its authentication, objects through the marketplace at 20:00                 | the recovery is cancelled: "u2" no longer has the administrator right, every user of "b1" is told, and it is recorded |
        | no administrator who held the right before objects by 10:00 the next day                          | the recovery is final, and "u2" may take every administrator action                                     |

    @X1-S21 @need-X1-N9 @POL-25
    Scenario: An account cannot have more than account_max_keys keys
      Given account "b1" has `account_max_keys` (POL-25: 100) agent keys that are not revoked
      When an account administrator of "b1" issues another agent key
      Then the request is refused, stating the limit
      And no key is issued

  Rule: Idempotency keys are scoped to the account

    @X1-S08 @need-X1-N4 @POL-29
    Scenario: The same idempotency key used by two accounts gives two independent requests
      Given account "b1" sent a booking request with idempotency key "same"
      When account "b2" sends a different booking request with idempotency key "same"
      Then "b2"'s request is decided on its own merits and is not refused as a reused key
      And "b1"'s request is unaffected

    @X1-S09 @need-X1-N4 @POL-29
    Scenario: An idempotency key reveals nothing about another account's request
      Given account "b1" sent a booking request with idempotency key "k"
      When account "b2" polls for the outcome of key "k"
      Then the answer is the same as for a key "b2" never used

  Rule: Only a link's own supplier changes what is sold on it

    @X1-S22 @need-X1-N10 @POL-07
    Scenario Outline: Nobody but the link's supplier books maintenance, announces a permanent reduction or records an outage or its restoration on it, network operations aside
      Given a link of supplier "s1"
      When <principal> tries to <change> on that link
      Then the request is refused as if the link did not exist
      And nothing changes

      Examples:
        | principal                 | change                                   |
        | a principal of "s2"       | book planned maintenance                 |
        | a principal of "s2"       | announce a permanent reduction           |
        | a principal of "s2"       | record an unplanned outage               |
        | a principal of buyer "b1" | book planned maintenance                 |
        | a principal of buyer "b1" | record an unplanned outage               |
        | a principal of "s2"       | record the restoration of an unplanned outage |
        | a principal of buyer "b1" | announce a permanent reduction           |
        | a principal of "s2"       | record a permanent increase of capacity  |
        | a principal of "s2"       | cancel planned maintenance               |

    @X1-S23 @need-X1-N10 @need-X1-N7 @POL-07 @POL-32
    Scenario Outline: Network operations may record an outage and its restoration, but not commercial changes
      Given an operator in the network operations role (POL-32)
      When the operator tries to <change> on a link of supplier "s1", giving a reason
      Then <result>

      Examples:
        | change                                     | result                                                        |
        | record an unplanned outage                 | it takes effect and is recorded with the operator and reason  |
        | record the restoration of capacity         | it takes effect and is recorded with the operator and reason  |
        | announce a permanent reduction             | it is refused, and nothing changes                            |
        | book planned maintenance                   | it is refused, and nothing changes                            |
        | record a permanent increase of capacity    | it is refused, and nothing changes                            |
        | register a new link for "s1"               | it is refused, and nothing changes                            |

  Rule: Only authentic payment notifications move money

    @X1-S10 @need-X1-N5
    Scenario: A notification not proven authentic moves no money and is recorded
      When a payment notification arrives that its provider's authenticity check does not prove authentic
      Then it is refused and no money moves
      And it is recorded for investigation

  Rule: A buyer can verify every webhook Share sends

    @X1-S11 @need-X1-N6 @POL-04
    Scenario: A webhook can be verified as coming from Share and unaltered
      When Share sends a webhook to a buyer
      Then the buyer can verify, from the webhook alone and what Share has given them, that Share sent it and that it was not altered

  Rule: Operator power is controlled and recorded

    @X1-S12 @need-X1-N7 @need-X1-N8 @POL-30 @POL-23 @POL-17 @POL-19 @POL-32 @POL-15 @POL-21 @POL-22 @POL-33 @POL-14
    Scenario Outline: An operator in the role that owns an action can take it, and the action is recorded with its reason
      Given an operator in the <role> role (POL-32)
      When the operator takes the action of <action> on account "b1", giving a reason
      Then the action takes effect
      And it is recorded with the operator, the role, the reason and the time

      Examples:
        | role               | action                                                                                                   |
        | network operations | terminating a reservation for network abuse (POL-30)                                                     |
        | compliance         | terminating a reservation for fraud or a sanctions or legal order (POL-30), approved by a second compliance operator |
        | finance            | correcting a price, with its cause (POL-23)                                                              |
        | finance            | attributing quarantined traffic to the account (POL-17)                                                  |
        | finance            | setting or removing a `credit_limit`, set only on an account that has passed know-your-business checks (POL-15) |
        | finance            | resolving an escalated payout to a supplier (POL-22)                                                     |
        | finance            | resolving an escalated reversal whose payment never arrived (POL-21)                                     |
        | compliance         | disclosing the account's identity to a supplier under a legal order that requires it (POL-33), approved by a second compliance operator |
        | finance            | setting the account's `usage_rate_cap` for a product (POL-14)                                            |
        | finance            | reversing a mistaken attribution of quarantined traffic to the account (POL-17)                          |
        | compliance         | erasing the personal data of a user of the account, at that user's request through an administrator of the account (POL-19) |

    @X1-S13 @need-X1-N7 @POL-32 @POL-30
    Scenario Outline: An operator is refused any action that belongs to another role
      Given an operator in the <role> role (POL-32)
      When the operator tries to <action>
      Then the request is refused and nothing changes
      And the attempt is recorded

      Examples:
        | role               | action                                             |
        | support            | correct a price                                    |
        | network operations | set a `credit_limit`                               |
        | finance            | terminate a reservation for network abuse          |
        | network operations | terminate a reservation for fraud                  |
        | compliance         | record an unplanned outage                         |
        | finance            | set a `reservation_price`                          |
        | support            | read the audit trail                               |
        | commercial         | correct a price                                    |
        | network operations | register a link                                    |
        | support            | erase a person's personal data                     |

    @X1-S31 @need-X1-N7 @need-X1-N8 @POL-32 @POL-01 @POL-12 @POL-07 @POL-06 @POL-19
    Scenario Outline: An operator in the role that owns an action not on one account can take it, and it is recorded
      Given an operator in the <role> role (POL-32)
      When the operator takes the action of <action>, giving a reason
      Then <result>
      And it is recorded with the operator, any approver, the role, the reason and the time (POL-19)

      Examples:
        | role               | action                                                                                       | result                                                              |
        | commercial         | setting a `reservation_price` for a product and route (POL-01)                               | it takes effect only once a second commercial operator approves it  |
        | commercial         | setting a supplier's split weight (POL-12)                                                   | it takes effect only once a second commercial operator approves it  |
        | commercial         | recording a partner's minimum term, cancellation fee and whether its legs can be decreased   | it takes effect                                                     |
        | commercial         | registering a link for supplier "s1", with its capacity (POL-07)                             | it takes effect                                                     |
        | commercial         | retiring a link on which nothing is reserved, held, offered or booked as maintenance from then on (POL-07) | it takes effect                                       |
        | network operations | declaring a region disaster, with the evidence of the loss (POL-06)                          | it takes effect only once a second network operations operator approves it |
        | compliance         | reading the audit trail                                                                      | the answer is given                                                 |

    @X1-S32 @need-X1-N7 @POL-32 @POL-30
    Scenario Outline: An action awaiting a second approval lapses, can be cancelled, and is refused if its preconditions no longer hold
      Given an operator in the compliance role asked to terminate reservation R of "b1" for fraud, and no second compliance operator has approved it (POL-30)
      When <event>
      Then <result>

      Examples:
        | event                                                                                | result                                                                    |
        | `approval_expiry` (POL-32: 72 h) passes                                              | the request lapses, R is unchanged, and a later approval is refused        |
        | the operator who asked cancels the request                                           | the request is cancelled, R is unchanged, and a later approval is refused  |
        | "b1" cancels R, and a second compliance operator then approves the request           | the approval is refused, because R no longer exists to be terminated       |

    @X1-S35 @need-X1-N2 @need-X1-N7 @POL-33 @POL-32
    Scenario Outline: A disclosure under a legal order has the order's scope and ends with it
      Given buyer "b1" holds reservations on links of supplier "s1" and of supplier "s2"
      And an operator in compliance disclosed "b1"'s identity to "s1" under a legal order <order>, approved by a second compliance operator (POL-33)
      When <when>
      Then "s1" sees "b1"'s identity on <shown>

      Examples:
        | order                                           | when                                              | shown                                                           |
        | that states no scope or end                     | "s1" views its links' schedules                   | "b1"'s reservations on links of "s1", and nothing of "s2"'s links |
        | whose stated end date has passed                | "s1" views its links' schedules                   | none of "b1"'s reservations                                     |
        | that states no scope or end                     | one compliance operator has ended the disclosure  | none of "b1"'s reservations                                     |

    @X1-S36 @need-X1-N7 @POL-30 @POL-32 @POL-07
    Scenario Outline: A termination notice is withheld only by compliance, under a legal order that forbids it, as part of the termination and approved with it
      When <who> terminates a reservation of "b1" <termination>
      Then <result>

      Examples:
        | who                                                                   | termination                                                                                            | result                                                                                         |
        | the network operations operator                                       | for network abuse, asking that its holder not be told                                                  | the termination takes effect, the request not to tell is refused, and the holder is told       |
        | an operator in compliance, approved by a second compliance operator   | for a legal order, recording in the same action, and citing the order, that the order forbids telling the holder | the holder is not told, and the order is recorded with the termination                |
        | an operator in compliance, approved by a second compliance operator   | for a legal order, without withholding the notice, and a compliance operator then asks, citing the order, that the holder not be told | the later request is refused, and the holder is told within `affected_notice_time` (POL-07) |

    @X1-S16 @need-X1-N7 @POL-30 @POL-32
    Scenario: An operator cannot end a reservation for a reason outside POL-30
      Given an operator in the network operations or the compliance role (POL-32)
      When the operator tries to end a reservation of "b1" for a reason that is not fraud, a sanctions or legal order, or network abuse
      Then the request is refused and the reservation is unchanged
      And the attempt is recorded

    @X1-S17 @need-X1-N7 @POL-30 @POL-32
    Scenario: A termination is recorded with its reason and operator, and the holder is told where the law allows
      Given an operator in the network operations role (POL-32)
      When the operator terminates a reservation of "b1" for network abuse
      Then the termination records the reason and the operator
      And the holder of the reservation is told within `affected_notice_time`, with the reason, as for every termination for network abuse (POL-30)
      And its charges stop at the termination (P3)

    @X1-S26 @need-X1-N7 @POL-30 @POL-32
    Scenario: A termination for fraud or a legal order takes effect only with a second compliance operator's approval
      Given an operator in the compliance role (POL-32)
      When the operator terminates a reservation of "b1" for fraud, giving a reason
      Then the termination does not take effect, and the reservation is unchanged, until a second operator in the compliance role approves it
      And the operator who asked cannot approve it
      And once approved it takes effect, recorded with both operators, the reason and the time

    @X1-S27 @need-X1-N7 @POL-32 @POL-08
    Scenario Outline: Support reads, and acts on an account only at its documented request
      Given an operator in the support role (POL-32)
      When the operator <action>
      Then <result>

      Examples:
        | action                                                               | result                                                      |
        | reads the reservations of "b1"                                       | the answer is given, and the read is recorded               |
        | cancels a reservation of "b1" at "b1"'s documented request, made through the marketplace by an authenticated principal of "b1" who may cancel it | the cancellation takes effect as "b1"'s own change (POL-08), with "b1"'s fees and charges, recorded as an operator action with the request |
        | cancels a reservation of "b1" without a documented request from "b1" | it is refused, nothing changes, and the attempt is recorded |
        | cancels a reservation of "b1" on a request received only by e-mail or telephone | it is refused as not a documented request, nothing changes, and the attempt is recorded |

  Rule: Every change to money, capacity, links or keys is attributable, and the record is fixed

    @X1-S14 @need-X1-N8 @POL-19 @POL-07 @POL-16 @POL-30
    Scenario: Every change to money or capacity records the principal and the time
      When any principal confirms, changes, cancels, revokes, releases or terminates a reservation, changes a link's capacity, moves money, grants or removes an operator role or an administrator right, gives or withdraws consent, changes a price, weight, partner term or other policy setting, or registers or changes a webhook endpoint
      Then the change records that principal, by its pseudonymous identifier, and the time

    @X1-S15 @need-X1-N8 @POL-19
    Scenario Outline: An audit record cannot be altered or removed, and an alteration below the system is detected and accepted by no reader
      Given an audit record of a change
      When <who> tries to alter or remove it
      Then <result>

      Examples:
        | who                                                                                         | result                                                                                                     |
        | any principal, operators included, through the system                                       | the attempt is refused and itself recorded, and the audit record is unchanged                              |
        | an administrator with administrative or physical access to the storage, below the system     | the alteration or removal is detected and recorded, and no reader accepts the altered record or the gap left as the audit record |

  Rule: Personal data can be erased without altering the audit or the books

    @X1-S34 @need-X1-N11 @need-X1-N8 @POL-19
    Scenario: Erasing a person's personal data leaves every audit and financial record unaltered and attributable
      Given a user "u1" of "b1" made changes and money movements that are recorded in the audit trail and the ledger
      When "u1"'s personal data must be erased, and is erased
      Then "u1"'s personal data can no longer be recovered from anything Share holds (POL-19)
      And every audit record and money movement of "u1" is unchanged, still attributed to "u1"'s pseudonymous identifier for the retention period
      And recomputing any balance or charge from the records gives the same result as before the erasure

    @X1-S39 @need-X1-N11 @need-X1-N7 @POL-19 @POL-32
    Scenario Outline: An erasure the data subject requests is executed by one compliance operator, and is complete in every copy within erasure_max
      Given user "u1" of "b1" asks that its personal data be erased, <channel>
      When an operator in compliance erases it, giving the request as the reason (POL-32)
      Then the erasure takes effect with that one operator, recorded with the operator, the request and the time, by pseudonymous identifiers (POL-19)
      And within `erasure_max` (POL-19) of the request, "u1"'s personal data can no longer be recovered from the live store, from any backup or from any escrowed copy

      Examples:
        | channel                                                                    |
        | through an account administrator of "b1"                                   |
        | by a documented request to support, made through the marketplace by "u1"  |

    @X1-S42 @need-X1-N11 @need-X1-N7 @POL-19 @POL-32
    Scenario Outline: An erasure is executed only on a recorded request from a channel open to its subject
      Given <request>
      When an operator in compliance acts on it (POL-32)
      Then <result>

      Examples:
        | request                                                                                                                                                       | result                                                                                                                                                             |
        | operator "o1" asks, through Share's workforce administration, that its own personal data be erased                                                            | the request is recorded, and the operator erases "o1"'s personal data, recorded with the request; within `erasure_max` (POL-19) of the request's record it can no longer be recovered from any copy |
        | a person who is not a Share user, or someone acting for that person, sends a documented erasure request naming exporter "x1" of supplier "s1" and the days D to D + 3, with evidence of identity | once the operator verifies it, the payloads "x1" sent in those days that were rejected as not conforming to the record template are erased, recorded with the request, and can no longer be recovered from any copy within `erasure_max` of the request's record (POL-19) |
        | the same documented erasure request, whose identity or authority the operator cannot verify                                                                   | it is refused and recorded, nothing is erased, and its sender is told                                                                                               |
        | user "u2" of "b1" asks, by a documented request through the marketplace, that user "u1"'s personal data be erased                                            | it is refused and recorded, and nothing is erased: a user asks only for its own data (POL-19)                                                                        |
        | an agent key of "b1" asks that a user's personal data be erased                                                                                               | it is refused and recorded, and nothing is erased                                                                                                                   |

    @X1-S43 @need-X1-N11 @need-X1-N7 @POL-19 @POL-32
    Scenario Outline: Compliance opens an erasure with no request only on a documented legal requirement, with a second compliance operator's approval
      Given no erasure request names user "u1" of "b1"
      When an operator in compliance opens an erasure of "u1"'s personal data <basis>
      Then <result>

      Examples:
        | basis                                                                                                    | result                                                                                                                                                           |
        | citing a documented legal requirement, with its legal reference, and a second compliance operator approves it | it is recorded as an erasure request with that legal reference, `erasure_max` (POL-19) running from that record, and one compliance operator may then execute it |
        | citing a documented legal requirement, and no second compliance operator has approved it                | nothing is recorded as a request and nothing is erased, and it lapses after `approval_expiry` (POL-32)                                                            |
        | citing no legal requirement                                                                              | it is refused and recorded, and nothing is erased                                                                                                                |

    @X1-S37 @need-X1-N11 @POL-19
    Scenario: Logs and records hold no personal data
      When any principal acts, and its action is logged and recorded
      Then the logs, audit records, history and financial records identify it only by its pseudonymous identifier, and hold no name, contact detail or other personal data (POL-19)
