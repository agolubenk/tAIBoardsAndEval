# Эволюционная система задач (Evolutionary Task Management)

## Концепция

Предлагаемая система задач основана на идее, что каждая задача эволюционирует в свое дерево, а связанные задачи могут объединяться в группы. Это позволяет создавать гибкую и масштабируемую структуру для управления сложными проектами.

### Основные идеи:

1.  **Мем-секции (Memory Sections)**: Каждая задача представлена как мем-секция с уникальным идентификатором.
2.  **Деревья задач (Task Trees)**: Каждая задача может иметь дочерние задачи, создавая иерархию.
3.  **Лес из мем-секций (Forest of Memory Sections)**: Системы задач объединяются в логические группы (кроны), которые могут быть связаны между собой.
4.  **Объединение задач (Fusing Tasks)**: Связанные задачи могут быть объединены в одну группу, создавая сросшиеся кроны.

## Структура данных

### Мем-секция (Memory Section)

```json
{
  "id": "unique_identifier",
  "title": "Task Title",
  "description": "Detailed description of the task",
  "status": "todo/in-progress/done",
  "type": "bug/feature/task/alert",
  "priority": "high/medium/low",
  "parent_id": null, // ID родительской задачи
  "children": ["child_task_id1", "child_task_id2"],
  "memories": {
    "context": "Compressed context of the task",
    "history": ["step1", "step2", ...],
    "attachments": ["file_path1", "file_path2"]
  },
  "tags": ["tag1", "tag2", "tag3"],
  "created_at": "timestamp",
  "updated_at": "timestamp"
}
```

### Лес из мем-секций (Forest of Memory Sections)

```json
{
  "forest_id": "unique_forest_identifier",
  "name": "Project Name",
  "description": "Description of the project",
  "tasks": [
    {
      "id": "task_id1",
      "title": "Main task",
      "status": "in-progress"
    },
    {
      "id": "task_id2",
      "title": "Subtask",
      "status": "todo",
      "parent_id": "task_id1"
    }
  ],
  "groups": [
    {
      "group_id": "group_id1",
      "name": "Authentication group",
      "tasks": ["task_id1", "task_id2"]
    },
    {
      "group_id": "group_id2",
      "name": "UI group",
      "tasks": ["task_id3", "task_id4"]
    }
  ]
}
```

## Процесс эволюции задачи

1.  **Создание задачи**: Создается новая мем-секция с корневой задачей.
2.  **Выполнение шага**: Сессия выполняет шаг, обновляя контекст и историю.
3.  **Сохранение контекста**: Контекст-кeeper проверяет лимит и сохраняет контекст в мем-секции, если необходимо.
4.  **Создание дочерней задачи**: Если задача требует разделения, создается новая мем-секция с родительской ссылкой.
5.  **Объединение задач**: Связанные задачи могут быть объединены в группы (сросшиеся кроны).

## Преимущества

*   **Гибкость группировки** связанных задач в логические структуры.
*   **Упрощение управления** сложными проектами через иерархию.
*   **Повышенная производительность** за счет оптимизации очереди.
*   **Сохранность задач** при переключении между сессиями или асинхронной обработкой.

## Реализация

### Шаг 1: Создание мем-секции
```python
# Пример создания новой задачи
task_id = create_mem_section(
    title="Implement new feature X",
    description="Detailed description...",
    status="todo",
    type="feature",
    priority="high"
)
```

### Шаг 2: Обновление контекста
```python
# Обновление контекста задачи
update_context(task_id, context_data="New context data")
```

### Шаг 3: Создание дочерней задачи
```python
# Создание подзадачи
child_task_id = create_child_task(
    parent_id=task_id,
    title="Subtask Y",
    description="Detailed subtask description..."
)
```

### Шаг 4: Объединение задач в группу
```python
# Объединение связанных задач
group_id = fuse_tasks([task_id1, task_id2], reason="Shared solution approach")
```

## Пример использования

1.  **Создание основной задачи**:
    ```python
    main_task = create_mem_section(
        title="Fix authentication bug",
        description="User cannot login with new password",
        status="todo",
        type="bug",
        priority="high"
    )
    ```

2.  **Выполнение шага**:
    ```python
    update_context(main_task, context_data="Found issue in auth service")
    ```

3.  **Создание дочерней задачи**:
    ```python
    subtask = create_child_task(
        parent_id=main_task,
        title="Check database schema",
        description="Verify password hash algorithm"
    )
    ```

4.  **Объединение задач**:
    ```python
    group = fuse_tasks([main_task, subtask], reason="Both tasks related to authentication")
    ```

## Заключение

Эволюционная система задач предлагает мощный подход к управлению сложными проектами. Она позволяет эффективно использовать контекст, сохранять состояние задач и группировать связанные задачи в логические структуры. Это решение должно значительно улучшить взаимодействие между сессиями, моделями и инструментами.