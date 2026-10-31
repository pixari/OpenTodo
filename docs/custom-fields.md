---
title: Custom fields
summary: Give the tasks of a project typed columns such as a cost, a client, a stage or a link, see them on rows, cards and columns, and filter by them.
audience: user
section: Guides
specs: [custom-fields]
screens: [project-fields]
order: 35
---
# Custom fields

<picture><source srcset="images/custom-fields-dark.webp" media="(prefers-color-scheme: dark)"><img src="images/custom-fields-light.webp" alt="The Side project list in the columns layout, with the columns Effort, Stage and Link next to each task."></picture>

A project can give its tasks a few typed fields of its own: a cost, a client, a stage, a link. Every task of the project can then hold a value for each, and you can see and filter them like any other property.

## Define the fields of a project

Open the project, open the **⋯** menu and choose **Fields…** (or press <kbd>Shift</kbd>+<kbd>F</kbd>). Type a name, pick a type and select **Add field**:

| Type | Holds |
| --- | --- |
| Text | up to 2,000 characters |
| Number | any number, shown with your language's digit grouping |
| Date | a calendar day |
| Choice | one of the options you list, one per line |
| Link | an `http` or `https` address |
| Checkbox | on or off |

A project has at most 30 fields, and two fields of one project cannot share a name. The type of a field is fixed once it exists. In the same dialog you can rename a field, edit the options of a choice, move a field up or down (drag it, or press <kbd>Alt</kbd>+<kbd>↑</kbd> / <kbd>↓</kbd> on its handle) and delete it.

Whoever may edit the project's tasks may manage its fields. Viewers of a shared project see the values but not the **Fields…** item. The Inbox has no fields.

## Fill in values

Open a task: the **Fields** group of the panel lists the project's fields in order, each with an editor that fits its type. A number or text is saved when you press <kbd>Enter</kbd> or leave the field, a choice opens with <kbd>Enter</kbd> or <kbd>Alt</kbd>+<kbd>↓</kbd>, and a link has a button that opens it in a new tab. Clear a value to leave it empty. Values work offline and sync like every edit; two people editing different fields of one task both keep their change.

## See values on rows, cards and columns

Rows and board cards show up to three values as small badges, such as **Cost 1,200** or **Paid**, and **+2** for the rest. On a wide screen a project's list offers a **Columns** button above its tasks: one column per field, read-only, with the task panel for editing. The choice is remembered per project on that device.

## Fields of sub-projects

A field applies to its project and to every sub-project below it. The **Fields…** dialog of a sub-project lists the inherited fields first, under **From** and the parent's name; edit them in the parent. No two fields that apply to a project share a name, and the limit of 30 counts inherited fields. Someone you share only the sub-project with sees its own fields, not the parent's.

## Move a task or delete a field

A task moved to another project keeps its values, but shows only the fields of its new project; move it back and they reappear. Moving a sub-project works the same way. Deleting a field asks first and says how many tasks hold a value: the values stay in the data and in the export, hidden.

Renaming an option of a choice field in place (same line) updates the tasks that held the old text.

## Filter by a field

Use a field's name in a [filter query](filters.md#custom-fields): `cost > 100`, `client = "Acme"`, `"Order date" <= friday`, `paid = true`, or `no client` for tasks without a value.
See [Group and order](group-and-order.md) for field sorting. The setting stores definition IDs, keeping encrypted names out of sync operations.
