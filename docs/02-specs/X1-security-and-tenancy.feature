# Spec for X1: security, tenancy and audit (cross-cutting; inherited by P1-P4).
# Problem statement: ../01-discovery/X1-security-and-tenancy.md
# Terms: glossary.md. Policies: policy-register.md.
#
# Tags: @X1-Snn is the scenario's stable ID; @need-X1-Nn is the need it serves; @POL-nn a
# policy it depends on. Conformance (design, tests, status) is kept in conformance.md.

Feature: Security, tenancy and audit

  As a buyer or agent operator
  I want my reservations, requests and money reachable only by my account and my keys
  So that nobody else can see, book against or spend from my account

  As a supplier
  I want to see my own links and settlements, and nobody else's
  So that the marketplace stays neutral between competitors

  As Share finance and compliance
  I want every change to money or capacity attributed to a principal, and operator power controlled
  So that every change can be explained and nobody can act unaccountably

  Rule: Every operation is performed by an authenticated principal

    @X1-S01 @need-X1-N1
    Scenario Outline: An unauthenticated request changes nothing and reveals nothing
      When an unauthenticated caller tries to <operation>
      Then the request is refused as unauthenticated
      And nothing changes and nothing about any account is revealed

      Examples:
        | operation                           |
        | book a route                        |
        | cancel a reservation                |
        | ask for a booking request's status  |
        | ask for a balance                   |
        | ask for a statement                 |

  Rule: A principal sees and changes only its own account's data

    Background:
      Given buyer accounts "b1" and "b2"

    @X1-S02 @need-X1-N2
    Scenario Outline: Another account's data cannot be read, and its existence is not revealed
      When a principal of "b2" asks for <item> of "b1"
      Then the answer is the same as for <item> that does not exist

      Examples:
        | item                    |
        | a reservation           |
        | a booking request       |
        | the balance             |
        | a statement             |

    @X1-S03 @need-X1-N2
    Scenario Outline: Another account's reservation cannot be changed
      Given "b1" holds a confirmed reservation R
      When a principal of "b2" tries to <change> R
      Then the request is refused as if R did not exist
      And R is unchanged

      Examples:
        | change         |
        | cancel         |
        | shorten        |
        | extend         |
        | change the rate of |

    @X1-S04 @need-X1-N2
    Scenario: A supplier sees only its own links and settlements
      Given suppliers "s1" and "s2", each with its own links
      When a principal of "s2" asks for the schedule of a link of "s1" or for the statement of "s1"
      Then the answer is the same as for a link or statement that does not exist

  Rule: An agent key acts only for its account, until it is revoked

    @X1-S05 @need-X1-N3 @POL-25
    Scenario: An agent key acts only for the account that issued it
      Given an agent key issued by account "b1"
      When the key tries to book or read on behalf of account "b2"
      Then the request is refused and nothing changes

    @X1-S06 @need-X1-N3 @POL-25
    Scenario: A revoked agent key is refused
      Given account "b1" has revoked one of its agent keys
      When the key is used for any operation
      Then the request is refused as unauthenticated

    @X1-S07 @need-X1-N3 @need-X1-N8 @POL-25
    Scenario: An operation by an agent key records the key
      When an agent key of "b1" books, changes or cancels a reservation
      Then the change records the key that made it, as well as the account

  Rule: Idempotency keys are scoped to the account

    @X1-S08 @need-X1-N4
    Scenario: The same idempotency key used by two accounts gives two independent requests
      Given account "b1" sent a booking request with idempotency key "same"
      When account "b2" sends a different booking request with idempotency key "same"
      Then "b2"'s request is decided on its own merits and is not refused as a reused key
      And "b1"'s request is unaffected

    @X1-S09 @need-X1-N4
    Scenario: An idempotency key reveals nothing about another account's request
      Given account "b1" sent a booking request with idempotency key "k"
      When account "b2" polls for the outcome of key "k"
      Then the answer is the same as for a key "b2" never used

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

    @X1-S12 @need-X1-N7 @need-X1-N8
    Scenario Outline: An operator with a permitting role can act on an account, and the action is recorded with its reason
      Given an operator whose role permits <action>
      When the operator does it to account "b1", giving a reason
      Then the action takes effect
      And it is recorded with the operator, the role, the reason and the time

      Examples:
        | action                       |
        | cancelling a reservation     |
        | correcting a price           |
        | writing off a balance        |

    @X1-S13 @need-X1-N7
    Scenario: An operator without a permitting role is refused
      Given an operator whose role does not permit correcting a price
      When the operator tries to correct a price
      Then the request is refused and nothing changes
      And the attempt is recorded

  Rule: Every change to money or capacity is attributable, and the record is fixed

    @X1-S14 @need-X1-N8 @POL-19
    Scenario: Every change to money or capacity records the principal and the time
      When any principal confirms, changes, cancels or revokes a reservation, or moves money
      Then the change records that principal and the time

    @X1-S15 @need-X1-N8
    Scenario: An audit record cannot be altered or removed
      Given an audit record of a change
      When any principal, operators included, tries to alter or remove it
      Then the attempt is refused and itself recorded
      And the audit record is unchanged
