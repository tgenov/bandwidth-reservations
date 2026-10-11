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
      Then it shows R's rate, window and endpoints and a reference to R that is used for no other reservation
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
      Then every later view by "s1" of that link's schedule shows nothing that identifies "b1" or links R to "b1"'s other reservations
      And the withdrawal is recorded with the administrator and the time

    @X1-S24 @need-X1-N2 @POL-04
    Scenario: A webhook goes only to its own account's endpoint and carries nothing about another account
      Given "b1" and "b2" have each registered a webhook endpoint
      When the outcome of a booking request of "b1" is known
      Then it is sent only to the endpoint "b1" registered
      And it carries nothing about "b2" or any other account

  Rule: An agent key acts only for its account, until it is revoked

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

  Rule: Only an account administrator manages agent keys and their limits

    @X1-S18 @need-X1-N9 @POL-25 @POL-33
    Scenario Outline: An account administrator issues, changes and revokes keys and sets their limits
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

    @X1-S20 @need-X1-N9 @need-X1-N8 @POL-25 @POL-19
    Scenario: Every change to an agent key or its limits records who made it and when
      When an account administrator issues, changes or revokes an agent key, or changes its limits
      Then the change records the administrator, the time, and the old and new values

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

    @X1-S12 @need-X1-N7 @need-X1-N8 @POL-30 @POL-23 @POL-17 @POL-19 @POL-32 @POL-15 @POL-21 @POL-22 @POL-33
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
      And the holder of the reservation is told, unless the law forbids it
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
        | cancels a reservation of "b1" at "b1"'s documented request           | the cancellation takes effect as "b1"'s own change (POL-08), with "b1"'s fees and charges, recorded as an operator action with the request |
        | cancels a reservation of "b1" without a documented request from "b1" | it is refused, nothing changes, and the attempt is recorded |

  Rule: Every change to money, capacity, links or keys is attributable, and the record is fixed

    @X1-S14 @need-X1-N8 @POL-19 @POL-07 @POL-16 @POL-30
    Scenario: Every change to money or capacity records the principal and the time
      When any principal confirms, changes, cancels, revokes, releases or terminates a reservation, changes a link's capacity, or moves money
      Then the change records that principal and the time

    @X1-S15 @need-X1-N8 @POL-19
    Scenario: An audit record cannot be altered or removed
      Given an audit record of a change
      When any principal, operators included, tries to alter or remove it
      Then the attempt is refused and itself recorded
      And the audit record is unchanged
